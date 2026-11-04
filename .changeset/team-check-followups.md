---
'clawboo': patch
---

Team chat's work check handles three rare board failures better. If a check could not run and the board would not move the task to Needs you, the task now stays in review and Clawboo tries the move again, instead of failing the run with the card still in review, where nothing picked it up. If the check passed but the board would not mark the task Done, the update to whoever handed it out now says exactly that, instead of saying the agent blocked the task. And if a fix round cannot start, the later steps of the task's plan stay queued, so a Retry carries the plan on, as when a check fails for good.
