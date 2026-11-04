---
'clawboo': patch
---

Clawboo now works with a task worktree recorded in the work folder, `~/clawboo-work` by default (`<CLAWBOO_HOME>-work` when `CLAWBOO_HOME` is set, or `CLAWBOO_WORK_DIR`), where a newer layout keeps task worktrees, review checkouts and team folders outside `~/.clawboo`. New ones still go in `~/.clawboo`. This makes it safe to roll a version that keeps them in the work folder back to this one.

Pausing and completing a task now act on the checkout the board records for it, where they used to rebuild the path under `~/.clawboo` and act on that; a record that is not the task's folder under `~/.clawboo/worktrees` or the work folder's `worktrees/` is refused before anything is removed. The work check runs in a checkout under either place and still refuses anywhere else, including the work folder's team folders. A paused task's checkout is rebuilt where the board records it. The worktree cleanup also sweeps the work folder's `worktrees/`, and marks a task's workspace stale only when the checkout the board records was the one removed. A repeat `POST /api/board/:taskId/workspace` returns the recorded checkout's path.
