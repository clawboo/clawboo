---
'clawboo': minor
---

Apps that run Clawboo as their own child process can now stop it cleanly over its IPC channel. A `{ "type": "shutdown" }` message stops the server the way SIGTERM does (it ends the agent runs, closes the database and exits with code 0), also on Windows, where a signal ends the process at once. With `CLAWBOO_STOP_ON_DISCONNECT=1`, the server also stops when that channel closes, so it stops with an app that quits or crashes. A server the `clawboo` command starts keeps running after the command returns, as before. See **Start it from your own app** on the deployment page.
