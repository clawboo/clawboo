---
'clawboo': patch
---

A teammate's result now reaches whoever handed the work off even if Clawboo restarts in between. The task update used to wait in memory, for a few seconds and then for as long as the lead was busy with another turn, so a restart in that window lost it: the result stayed on the board, but the lead never heard about it and never wrote its summary.

Each task update is now saved as soon as the task finishes, and it counts as delivered only once the run that received it has finished. If that run never finishes, because Clawboo stopped or restarted, the run failed, or it could not start, the update is sent again: within about half a minute while Clawboo keeps running, or shortly after it starts again. After 3 more tries it is given up, with a note in the chat that the results are on the board. Pressing Stop drops an update that was waiting for its recipient's turn, as before, and one whose run the Stop ended; deleting a room drops the updates still waiting in it the same way.
