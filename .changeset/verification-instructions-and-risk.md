---
'clawboo': patch
---

Checked task-runner work now has a fair first check. The agent is told before it starts, in its instructions and in the worktree's `TASK.md`, to set `VERIFY_CMD` in `init.sh` to the command that proves the work, so the first check no longer always fails on the placeholder. A task whose title or description names a risky action, such as deploy, delete, publish, production or secret, now always gets the reviewer, using the same words team chat uses to ask before a risky hand-off.
