---
'clawboo': patch
---

Team work survives the machine going to sleep. Closing a laptop's lid while agents were working used to fail every in-flight delegation on wake: the time asleep counted as silence, so each delegate's task was blocked, its plan steps were cancelled, and the lead was told it had timed out although nothing was wrong. Clawboo's watchdogs now notice that the process was suspended, from the gap between two of their own checks, and leave that time out.

This covers the team delegation watchdog (8 minutes, or 24 inside one long tool call), the per-session wedge timer that ended runs after 10 silent minutes, the run idle guard (30 minutes), the board sweep that releases tasks whose run stopped heartbeating, the 10-minute limit on a scheduled OpenClaw routine run, and the two-hour ceiling after which a team that looked silent was unloaded and its runs stopped. A delegate that really goes silent is still stopped at the same limits, counted in time the machine was awake.
