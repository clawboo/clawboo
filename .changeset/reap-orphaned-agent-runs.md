---
'clawboo': patch
---

Agent runs no longer outlive a Clawboo that stopped unexpectedly. When the server crashed or was force-quit, a Codex, Hermes or Claude Code run it had started, or a command you approved for an agent, could keep running and keep editing the task's folder after the next start handed that task back to the board. Clawboo now records every agent process it starts, and on its next start it stops the ones left behind by a server that is no longer running, before it hands their tasks back.

It only stops a process it can show is the one it recorded: started during the current system boot, less than 12 hours ago, and before the record was written. A second Clawboo running on the same data folder keeps its runs. When the system cannot report when a process started, nothing is stopped.
