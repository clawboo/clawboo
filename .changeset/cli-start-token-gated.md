---
'clawboo': patch
---

With `STUDIO_ACCESS_TOKEN` set, `clawboo` now sees the server it just started instead of printing "Dashboard is taking too long to start." and exiting while the server runs. The command uses the token from your shell, sent only to a port that answered with Clawboo's own access-token refusal, so `clawboo stop` and `clawboo restart` also work on a server whose token that shell has.
