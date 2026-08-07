---
'clawboo': patch
---

Reuse one SQLite connection per process instead of opening one per request, and bound the write-retry budget to 1.5 seconds of wall clock so a contended write can no longer block the server for seconds at a time.
