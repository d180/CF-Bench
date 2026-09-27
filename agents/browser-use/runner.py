"""
browser-use runner for CF-Bench.

Reads a task's ticket text on stdin, drives a real Chrome window against it,
and writes a JSON result to stdout. Knows nothing about grading - the harness
grades the zone afterwards, exactly as it does for a human or for Coasty.

Uses the system Chrome profile on purpose. Cloudflare's dashboard sits behind
its own bot protection and often emails a verification code on a new device;
an agent cannot get past either, and Coasty's docs are explicit that they do
not solve CAPTCHAs. Reusing a profile a person already logged in with removes
that problem entirely rather than trying to automate around it.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time


def emit(payload: dict) -> None:
    """Result goes to stdout; everything else to stderr, so the caller can parse."""
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


def call(obj: object, name: str, default: object) -> object:
    """Read a history field whether the library exposes it as a method or an attribute."""
    try:
        value = getattr(obj, name)
        return value() if callable(value) else value
    except Exception:  # noqa: BLE001 - a trace field must never fail the run
        return default


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run a CF-Bench task with browser-use")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--model", default=os.environ.get("BROWSER_USE_MODEL", "openai/gpt-5.1"))
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument("--headless", action="store_true", help="off by default so the run is watchable")
    parser.add_argument("--start-url", default="https://dash.cloudflare.com")
    args = parser.parse_args()

    ticket = sys.stdin.read().strip()
    if not ticket:
        emit({"ok": False, "error": "No ticket text on stdin."})
        return 1

    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        emit({"ok": False, "error": "OPENROUTER_API_KEY is not set."})
        return 1

    try:
        from browser_use import Agent, Browser, ChatOpenAI
    except ImportError as exc:
        emit({"ok": False, "error": f"browser-use is not installed: {exc}"})
        return 1

    # Claude does not currently work with browser-use, in both directions:
    #
    #  - With response_format on (the default), Claude compiles a grammar from
    #    browser-use's action-union schema and rejects it with "The compiled
    #    grammar is too large". Seen identically via Anthropic, Azure, AWS and
    #    Google on OpenRouter, so it is a model limit, not a flaky provider.
    #  - With browser-use's escape hatch on (dont_force_structured_output +
    #    add_schema_to_system_prompt), no response_format is sent and Claude
    #    prefixes its JSON with markdown commentary. browser-use then calls
    #    model_validate_json on the raw string with no extraction step, so it
    #    fails at line 1 column 1 every time.
    #
    # Neither is fixable from here, so the default is a model whose structured
    # output handles a schema this size. The escape hatch is still applied for
    # anthropic/* so the failure mode is the parser rather than a 400.
    is_claude = args.model.startswith("anthropic/")
    if is_claude:
        print(
            "warning: anthropic/* models are known to fail with browser-use "
            "(schema too large, or JSON wrapped in prose). Expect a void run.",
            file=sys.stderr,
        )

    llm = ChatOpenAI(
        model=args.model,
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",
        dont_force_structured_output=is_claude,
        add_schema_to_system_prompt=is_claude,
        # browser-use defaults this to 4096, which a reasoning model spends on
        # hidden reasoning before it has finished emitting the action object -
        # the request then fails with finish_reason='length' and an incomplete
        # structured output. Reasoning tokens are billed as output, so this is
        # a real cost knob, not just a limit.
        max_completion_tokens=int(os.environ.get("BROWSER_USE_MAX_TOKENS", "16000")),
    )

    # from_system_chrome reuses the profile you are already signed in with, so
    # the agent never meets the login page.
    try:
        browser = Browser.from_system_chrome()
    except Exception as exc:  # noqa: BLE001 - surface the reason, do not crash
        emit({"ok": False, "error": f"Could not attach to system Chrome: {exc}"})
        return 1

    # Open the dashboard before the first decision. This is environment setup,
    # not a hint: the ticket still says nothing about what to change, and a
    # Coasty run gets the equivalent by targeting a machine that has the
    # dashboard open. Without it the agent has to guess that it even has a
    # browser, and one already answered a ticket with an essay instead of
    # opening one.
    agent = Agent(
        task=ticket,
        llm=llm,
        browser=browser,
        initial_actions=[{"navigate": {"url": args.start_url, "new_tab": False}}],
    )

    started = time.time()
    try:
        history = await agent.run(max_steps=args.max_steps)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}", "seconds": round(time.time() - started, 1)})
        return 1

    # The agent's own opinion of how it went is recorded for the trace but is
    # never treated as the verdict - the harness grades the zone afterwards.
    emit({
        "ok": True,
        "task_id": args.task_id,
        "model": args.model,
        "seconds": round(time.time() - started, 1),
        "steps": call(history, "number_of_steps", 0),
        "agent_claims_success": call(history, "is_successful", None),
        "agent_self_report": str(call(history, "final_result", "") or "")[:2000],
        "errors": [str(e)[:300] for e in (call(history, "errors", []) or []) if e],
        "urls_visited": [str(u) for u in (call(history, "urls", []) or [])][-10:],
    })
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
