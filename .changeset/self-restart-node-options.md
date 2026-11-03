---
'clawboo': patch
---

After an update from the dashboard, the server restarts with the node options it was started with. A server started as `node --max-old-space-size=4096 dist/server.js` used to come back with Node's defaults. The inspector's options are left out, since the old server still holds its port.
