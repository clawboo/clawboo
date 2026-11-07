---
'clawboo': patch
---

**Retry** now rescues a board task whose Claude Code run outgrew the model's context window. Such a run ends as out of room, and the task is blocked. Until now its session was kept for the task's next run, so every Retry continued the session that had overflowed, which overflowed again and blocked the task again. Now a run in team chat that reports a context overflow leaves no session behind, and the next run starts fresh. Claude Code, Codex in both its modes, Hermes and Clawboo Native report one; for all of them but Claude Code this saves one failed Retry. A task already blocked this way before the update overflows once more on its first Retry, which drops the session, and the Retry after that starts fresh.
