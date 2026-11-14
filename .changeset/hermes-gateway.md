---
'clawboo': minor
---

Hermes now runs as the real, current Hermes, through its own gateway. Installing Hermes from **Settings** > **Runtimes** installs release 0.23.1 from GitHub into Clawboo's runtimes folder, with the uv and Python 3.14 builds that release pins for itself, each download checked against a pinned hash: no Python of your own, no pip or pipx, and nothing piped into a shell. A Hermes installed earlier with pip or pipx reads **Update needed** until you install Clawboo's own.

Clawboo then runs one Hermes gateway with only its API server on, on `127.0.0.1` (port 8642, or the next free one; `CLAWBOO_HERMES_GATEWAY_PORT` sets it), keyed from the vault, and drives every Hermes agent through it, the way OpenClaw's agents run through OpenClaw's Gateway. It starts when Clawboo has Hermes agents or when one first works, restarts after a crash, stops with Clawboo, and shows in a Gateway section on the Hermes row. Each agent is a Hermes profile there, and its earlier Hermes home moves in on its first run, so its memory, skills and sessions carry over.

A Hermes run now streams its text and tool calls, takes a comment into the running turn, reports its tokens, and asks before the commands Hermes's own policy flags: each question is an approval card in **Needs you** and the chat (each profile's `approvals.mode` is set before every run to the one your own `~/.hermes/config.yaml` chooses, else `manual`; the rest of a profile, its `command_allowlist` included, stays the agent's to change). Jobs a Hermes agent schedules in Hermes show in **Routines** under **Hermes's own jobs**, where you can disable, enable, run or delete them; team work stays a Routine and is refused through Hermes's scheduler. Hermes's chat channels stay off. Clawboo no longer starts `hermes acp` or `hermes chat`, and `CLAWBOO_HERMES_TRANSPORT` is gone.

Clawboo's MCP servers accept a "live" attach URL that names only an agent and is bound, call by call, to that agent's run in progress, for a runtime that keeps one connection across runs.
