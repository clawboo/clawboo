---
'clawboo': minor
---

A task that hands out work now waits for it. On a team chat run, a task whose run ends with sub-tasks still going no longer closes: the card reads "Waiting on 3 sub-tasks", and how many of those need you. When they have closed its agent gets one more turn with all their results, and the task is done after that turn, even if the server restarted in between. A sub-task that failed reaches that turn marked as failed, and the parent then comes to Needs you naming it, instead of closing as done. Retry that sub-task, and the parent starts again by itself once none is left unfinished. A team with a work check checks the parent at the end of that turn. After a Stop no such turn starts: the parent reads Stopped and offers Retry.

Agents on a team chat run can say how a task went with the new `report_result` tool. It is a report, not a move: saying it is not done stops a Done and sends the task to Needs you, and saying it is done never gets past a failing check. An agent that never calls it behaves as before.
