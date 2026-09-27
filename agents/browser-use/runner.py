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


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run a CF-Bench task with browser-use")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--model", default=os.environ.get("BROWSER_USE_MODEL", "anthropic/claude-opus-5"))
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument("--headless", action="store_true", help="off by default so the run is watchable")
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

    llm = ChatOpenAI(
        model=args.model,
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",
    )

    # from_system_chrome reuses the profile you are already signed in with, so
    # the agent never meets the login page.
    try:
        browser = Browser.from_system_chrome()
    except Exception as exc:  # noqa: BLE001 - surface the reason, do not crash
        emit({"ok": False, "error": f"Could not attach to system Chrome: {exc}"})
        return 1

    agent = Agent(task=ticket, llm=llm, browser=browser)

    started = time.time()
    try:
        history = await agent.run(max_steps=args.max_steps)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}", "seconds": round(time.time() - started, 1)})
        return 1

    # The agent's own opinion of how it went is recorded for the trace but is
    # never treated as the verdict - the harness grades the zone.
    emit({
        "ok": True,
        "task_id": args.task_id,
        "model": args.model,
        "seconds": round(time.time() - started, 1),
        "steps": len(getattr(history, "history", []) or []),
        "agent_self_report": str(history.final_result() or "")[:2000],
    })
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
