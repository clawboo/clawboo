---
'clawboo': patch
---

An OpenClaw agent deleted while its Gateway is down no longer comes back. Before, only Clawboo's copy was removed: the next time the Gateway connected, the agent reappeared without its team and was then put into the first team. Clawboo now remembers the delete, sends it to the Gateway on the next connection, and keeps the agent out of the sidebar and the graphs until then. If the Gateway refuses the delete, for example because it is its only agent, the agent comes back.
