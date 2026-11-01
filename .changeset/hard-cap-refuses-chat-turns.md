---
'clawboo': patch
---

A paused hard-cap budget now refuses new team-chat and one-to-one chat turns before they start. Team chat (General, rooms, team routines, Board tasks and hand-offs) checked no budget before a turn, so a team kept working after its budget read paused, and only a priced Clawboo Native run could be stopped. Each run now checks the agent's budget, the team's and, for a run on a task, its mission's, the same way the task runner does. A refused message gets a notice in the chat naming the paused budget instead of a reply. A refused hand-off or Board task is not started: it waits in **Needs you** with the same reason in a comment, and the agent that handed it off is told why. A refused team routine records that reason as its error. One-to-one chat checks only the agent's own budget, the one it is charged to. A run already going when a cap pauses still finishes unless it is a priced Clawboo Native run, so press **Stop** to end it.
