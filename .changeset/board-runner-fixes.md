---
'clawboo': patch
---

The task runner now handles a task its own agent blocked: the run ends as succeeded with the agent's reply kept, no "late result", the steps waiting on it left queued, the delegator told, and a worktree kept for a Retry. `block_task` with no id blocks the run's own task on these runs too. A crash while a task runner's work is being checked no longer leaves the card stuck on Verifying: the run stays open until the verdict, so a restart puts the task in Needs you. When Clawboo moves a deleted room's unfinished task, it also aborts that task's OpenClaw run in the Gateway, waiting for the Gateway to connect if needed.
