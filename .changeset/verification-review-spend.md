---
'clawboo': patch
---

The reviewer that checks larger or handed-off task-runner work now counts toward budgets. Its run is charged to the same agent, mission and team as the work it reviews and shows in Tokens Used. Completing a task's worktree through the API also works when the task is back in To do: an empty diff lands it in Done and a non-empty one runs the check, where before the task silently stayed in To do.
