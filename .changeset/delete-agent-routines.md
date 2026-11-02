---
'clawboo': patch
---

Deleting an agent deletes the routines that send work to it. They used to stay behind and fail with `agent ... not found` on every run until removed by hand. Team routines target no agent and are not affected. The same cleanup runs when Clawboo drops OpenClaw agents the Gateway no longer has.
