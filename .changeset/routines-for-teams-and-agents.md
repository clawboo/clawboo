---
'clawboo': minor
---

The Scheduler is now Routines, and a routine goes where you point it.

A routine is either a team task or an agent task. A team task posts its instructions into the team's group chat, addressed to the team's lead (Boo Zero), which answers or brings in teammates exactly as it would for a message you typed. The message shows in the chat under the routine's name, and the lead is told nobody may be watching, so it carries the work out instead of waiting on questions. An agent task gives one agent a task: the dialog asks for a team, then an agent on it, and the result lands on the task card, which the team chat shows too. The old "Its own life" choice, which created an OpenClaw Gateway cron job, is gone from the dialog. Existing Gateway jobs are still listed in their own section, where they can be enabled, disabled, run, or deleted.

Every routine now opens. Its view says where it sends, what it does, and when it runs next, and lists its recent runs with how each went, linking an agent run to its task. A routine can be edited in place: who it is for, the instructions, the name, and the schedule, which now takes a custom cron expression with a preview of the next run.

Fixed along the way:

- An agent routine for a native, Claude Code, Codex, or Hermes agent failed with `dispatch refused: workspace_unavailable`. A scheduled task defaulted to a kind that needs a git worktree, and a routine has no repository to make one from. It now runs the way the agent works a task delegated in team chat. A routine given a `repoPath` through the API still gets its own worktree.
- An OpenClaw agent's routine finished its task, but nothing led to the result. Its runs were recorded under the executor type the team engine uses for its own runs, so the engine treated them as its own and never reported them finished. They now record their own type, and each run links to its task, where the agent's report is.
- Creating an OpenClaw Gateway cron job through the API paired an `agentTurn` payload with the main session, which the Gateway accepts and then skips on every fire, and updates were sent in a shape OpenClaw 2026.9 rejects. The session now follows the payload kind, and updates go under `patch`.
- One long run held up every other routine until it finished, and Run now waited for the next rescan, up to a minute. Routines now start on time whatever else is running, and Run now starts within a moment. `CLAWBOO_ROUTINE_DISPATCH_DEADLINE_MS` is gone, since the scheduler no longer waits on runs.
- A run that ended on a runtime error without a final message gave its reason only as `(no output)`. It now reports the error the runtime gave. A failed agent run's task moves to Blocked with a note naming the agent and the error, instead of sitting in To do where any agent could claim it. That holds when the run throws rather than failing cleanly too, including an OpenClaw run whose connection drops mid-stream, which used to leave its task In progress with nothing driving it.
- A routine could be resumed through the API while a run was still in flight, which armed it to fire again on top of that run. Pause and resume are now refused until the run finishes, and a run's outcome only lands on a routine that is still running.
- Cancelling a confirmation opened from inside a dialog, such as deleting a routine or a status change in the task drawer, also closed the dialog behind it. A confirmation now keeps its own clicks.
