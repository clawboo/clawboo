---
'clawboo': patch
---

Deleting an agent deletes the routines that send work to it. They used to stay behind and fail with `agent ... not found` on every run until removed by hand. Team routines target no agent and are not affected. An OpenClaw agent deleted while its Gateway is offline keeps its routines until the Gateway confirms the delete, so a Gateway that refuses it and brings the agent back does not lose them. `POST /api/agents/cleanup-ghosts` also removes the routines of the rows it deletes.
