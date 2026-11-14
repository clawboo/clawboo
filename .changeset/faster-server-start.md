---
'clawboo': patch
---

The server answers sooner after it starts. Its startup check of the database ran SQLite's full integrity check on the main thread right after it began listening, so on a large database every request, the dashboard's first page included, waited several seconds for it. The startup check is now SQLite's quick check, in a background thread; the full one runs the same way once a day and on **Re-run probe** in **System Health**. A check that cannot run there, or runs out of time, reads as degraded rather than as damage. `clawboo` also keeps Node's compiled copy of the server between starts, in `~/.clawboo/cache/compile`.
