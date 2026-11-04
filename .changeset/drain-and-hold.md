---
'clawboo': minor
---

`clawboo stop`, `clawboo restart` and the in-app update now wait for agent runs to finish instead of cutting them off.

**Stop and restart wait for agents.** Before they stop the server, `clawboo stop` and `clawboo restart` hold it, so it starts no new agent run, and wait up to 10 minutes for the runs already going. The spinner says how many are left. At the bound they stop anyway. `--wait <seconds>` sets the bound, `--force` stops at once as before, and Ctrl+C cancels the wait and leaves the server running (exit code 130). A server too old to be held is stopped at once; one that does not answer the request to hold it is not stopped, and the command exits 1.

**The in-app update waits too.** Once the new version is installed, the server waits up to 10 minutes for the agent runs still going before it restarts, and no new run starts in the meantime (nor during the first 5 minutes of the install). The update chip reads "Waiting for N agent runs to finish before restarting." and offers **Restart now**. A failed install lets work start again. One update runs at a time: a second request while one runs is refused with `IN_PROGRESS`.

**Your own stop scripts can do the same.** `POST /api/system/hold` holds the server under an owner id you pick, `GET /api/system/hold` says whether any agent run is still going (`backgroundWork: "present"` or `"none"`), and `DELETE /api/system/hold/:owner` releases it. Only the owner that placed a hold releases it, and a hold lapses after 60 seconds (5 seconds to 15 minutes with `ttlSeconds`) unless it is placed again, so a stop script that crashes cannot leave the server held. `self-update` is the in-app update's own owner id. While held, every run the server would start waits in the run queue, tasks agents hand each other stay in To do, and a Routine that falls due fires once the hold lifts or the server starts again. A 1:1 chat with an OpenClaw agent runs in the OpenClaw Gateway, outside the hold. The new `system.hold` flag in `GET /api/system/capabilities` says a server has it.
