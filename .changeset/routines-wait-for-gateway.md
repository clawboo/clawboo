---
'clawboo': patch
---

A due routine that runs on an OpenClaw agent, or a team routine whose message goes to one, now waits up to 5 minutes for the Gateway to connect instead of failing on it. Right after Clawboo starts, the Gateway connects a few seconds later, so a routine that came due while Clawboo was stopped or the computer was asleep used to fail and wait for its next time; it now runs once the Gateway is back, as other routines already did. The schedules list also says when no OpenClaw Gateway is set up at all (`not_configured`), rather than reporting one that is set up but disconnected.
