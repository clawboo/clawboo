---
'clawboo': minor
---

A run's ending is now told apart, and retried only when a retry can help. An empty reply gets one more turn and then waits in Needs you as No result, so it no longer lands in Done unless a work check passed what it changed. A run that handed work out or used report_result is not an empty reply. A provider rate limit, overload or network error goes back to To do and tries again twice, after 30 and 60 seconds of awake time, holding no run slot or budget while it waits. Running out of room in team chat gets one continuation. Crashes and errors have separate limits. A budget cap or the circuit breaker stopping a run has its own status, so neither reads as your Stop any more, and a task waiting for room in a budget starts by itself when that room comes back.
