---
'clawboo': patch
---

`POST /api/team-chat/exchange` runs its turns again. It used to cancel every exchange as soon as it started, because it took the end of the request body for a client disconnect. It now stops only when the client really disconnects.
