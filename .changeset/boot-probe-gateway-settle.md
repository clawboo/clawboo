---
'clawboo': patch
---

Stop System Health reporting a permanently unreachable Gateway on an install where the Gateway is connected and serving.

The boot probe is fired as `void runBootProbe(...)` at the same moment the Gateway connect starts, and its reachability check took a single instantaneous sample. On a healthy install that sample landed mid-handshake: the probe ran at +60ms and `hello-ok` arrived at +187ms, so the check read `connecting` and recorded a failure. Because `/api/health` serves `getLastBootReport()`, a snapshot taken once and never recomputed, that failure then stood for the life of the process. Every boot logged `Boot probe: running degraded`, and the System Health view reported `OpenClaw Gateway not reachable, serving last-synced agents from SQLite` about a Gateway that had been connected the entire time.

The check now waits for the connection to settle, polling to the same 1500ms budget it already had rather than answering before the answer could be true. A Gateway that is genuinely down still reports unreachable and still only degrades, never fails the boot; it just takes the full window to say so. An already-connected Gateway answers immediately and pays nothing.

The staleness of the snapshot itself is left alone: serving the boot report from GET is deliberate, and the "Re-run probe" button (`POST /api/health/recheck`) is the intended way to refresh it. What was wrong here was the probe sampling before the thing it measures could exist, not the caching. A warning that is always wrong is worse than no warning, because it teaches people to ignore the real one.
