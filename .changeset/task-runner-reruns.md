---
'clawboo': patch
---

**Retry** and **Assign** on a task the task runner ran now run it through the task runner again, instead of handing it to team chat.

The task runner runs agent Routines and `POST /api/runtimes/:id/run` on Clawboo Native, Claude Code, Codex and Hermes. It gives a run a git worktree when the task names a repository and checks the work before **Done**; team chat does neither. A rerun from the board used to go to team chat, so it lost both. The runner now saves what it ran a task with (runtime, agent, repository, kind and model), and **Retry** or **Assign** on that task runs it the same way again. **Assign** uses the new agent's runtime, and keeps the saved model only on the same runtime. A reply on the task and the automatic restart after a failed run go through the runner too. A rerun that cannot start, for example because a budget is paused, moves the task to Needs you with the reason, and a rerun of a task paused for a handoff runs to the end instead of pausing again. An agent on OpenClaw, which the runner does not run, still gets team chat, and a removed agent's task asks for an Assign. Tasks the runner ran before this version saved nothing, so their reruns still go to team chat.
