---
'clawboo': minor
---

The board has a Needs you column, and a task you create goes to one agent.

**New task** now asks for a team, then an agent on it, then the task. The task is bound to that agent and starts right away, or waits in To do while the agent is busy and runs when it is free. It shows on the board and as a card in the team chat, and only that agent works on it: the result lands on the task card, and the team lead is not asked to follow up. Before, a task created from the board was given to nobody and sat in To do.

The Needs approval column is now **Needs you**, and it stays open when empty. Besides pending approvals, it holds every task nothing on the board will move by itself, with a badge saying why: Failed (Failed 3× after repeated failures), Timed out, Stopped, Needs review, Blocked, or Unassigned. Each card shows the error or reason and offers Retry, Assign, or Dismiss. Retry also works on a task Clawboo stopped retrying on its own.

In review and Blocked are no longer columns. A task being verified stays in In progress with a Verifying badge, and a blocked task shows in Needs you. The task statuses themselves are unchanged.

Task cards in the team chat have a Comments & activity button that opens the task's comment log and live activity inside the card, and an Open on board button that opens the task's full view on the Board. The task drawer shows the brief, the agent and team, and the comment log, and a stuck task can be handed to another agent from it.

`POST /api/board` accepts `assigneeAgentId`, `POST /api/board/:taskId/retry` and `POST /api/board/:taskId/assign` are new, and board task rows carry an `attention` field naming why a task needs you.

Fixed along the way:

- A task handed to an agent while it was still replying in the chat was completed with that reply, and the task's own output then appeared in the chat. A task now waits until its agent is free.
- A task update to the team lead listed work that had failed for good or been stopped as still outstanding, so the lead kept waiting on it.
- A stuck task kept the chat's Stop button showing longer after every reply.
- A team whose chat had board task cards but no messages showed the empty welcome screen and hid the cards.
