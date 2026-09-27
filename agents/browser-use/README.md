# browser-use agent

A local agent that drives a real Chrome window against a CF-Bench task.

    python3 -m venv .venv
    ./.venv/bin/pip install -r requirements.txt

Driven by the CLI, not by hand:

    npm run cf-bench -- agent-run 01-ssl-redirect-loop --agent browser-use

It reuses your system Chrome profile, so sign in to the Cloudflare dashboard
once in your normal browser first. That is deliberate: the dashboard is behind
Cloudflare's own bot protection and emails a verification code on a new
device, and no agent gets past either.

Reads the ticket on stdin, writes one JSON object to stdout. It never grades
itself - the harness grades the zone after the run, the same way it grades a
human attempt.
