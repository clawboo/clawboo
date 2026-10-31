---
'clawboo': patch
---

An agent can no longer move a card back after you moved it. When you move a task on the board while an agent is still working on it, the run is stopped, but a coding agent could still call its task tools before the stop landed and put the card back where you took it from. Those status changes are now refused, with a message telling the agent the task's status is yours to set and not to try again. Once the task runs again, the agent's status changes work as usual.
