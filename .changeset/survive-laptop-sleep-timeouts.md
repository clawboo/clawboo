---
'clawboo': patch
---

Five more of Clawboo's time limits now count only time the machine was awake, so closing a laptop's lid no longer fails work that was fine when the lid closed.

- A run waiting for its turn on an agent that is busy with another run (up to 10 minutes) is no longer refused on wake. Before, the team delegation failed to start, a scheduled routine on that agent stopped firing, and a direct message got "This agent was busy" instead of an answer.
- A task's verify command (10 minutes) that was still running is no longer killed on wake, which had marked the check as failed and used up one of the task's fix attempts.
- A command you approved for an agent (5 minutes) is no longer killed on wake.
- An agent's browser is no longer closed as idle (10 minutes) on wake, so the page it was working on survives.
- A message steered into an OpenClaw run before the sleep can no longer end that run when the Gateway confirms it after the wake.

Each limit still applies at its usual length, counted in time the machine was awake. A sleep of under about a minute can still count.
