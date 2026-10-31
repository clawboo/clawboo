---
'clawboo': patch
---

The OpenClaw Node.js range now matches the OpenClaw release Clawboo installs. Since 2026.9.34, OpenClaw needs Node 24.22.1 or later on the 24 line, or 26.12.1 or later (`>=24.22.1 <25 || >=26.12.1`). `GET /api/system/status` used to report Node 22 and Node 25 as `sufficient`; on those versions npm quietly installs an older 2026.9 patch instead of the current one. It now reports them as not sufficient, and `node.required` shows the new range.
