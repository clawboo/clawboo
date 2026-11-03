---
'clawboo': patch
---

Rebuilding a task's worktree no longer deletes uncommitted work, and the preview, the Workspace tab and the task drawer no longer follow a link an agent planted in its worktree.

A task that runs again rebuilds its checkout from the task branch when Clawboo thinks the checkout is gone. That check answered "gone" whenever `git worktree list` failed, for example on a timeout, and the rebuild then deleted the folder, uncommitted changes included. Clawboo now tells "not listed" apart from "git did not answer". When git does not answer, the run does not start, nothing is changed, and the task goes back to To do with a `[not started: worktree unchecked]` comment. A folder is replaced only when it holds nothing the rebuild would lose. One with uncommitted changes, or one git cannot read, is left as it is: the run does not start, and the task waits in Needs you with a `[blocked: worktree kept]` comment that names the folder. Startup cleanup skips such a folder instead of removing it, and `POST /api/board/:taskId/workspace` answers `409 unsafe_to_rebuild`.

The artifact preview checked a file and then opened it by name, so an agent could swap the file, or a folder above it, for a link to another file between the two steps, and the server would send that file. The preview, the Workspace tab's file view and the task drawer's task files now open each file so that a link is refused, and check after the open that the file is still the one inside the worktree. A task file that is a link is left out of the drawer.
