---
'clawboo': patch
---

Routines have a time zone of their own, independent of the server process. They used to run in the process's zone, which in a container is UTC unless `TZ` is set, so a routine set for 9:00 ran at 9:00 UTC. The routine dialog now says which zone a routine's time is in, with **Change** to pick another for every routine; it starts as the server's own zone, so an install that never sets one runs exactly as before. Changing it moves each armed routine's next run to the new zone. `GET` and `PUT /api/schedules/time-zone` read and set it, and `GET /api/schedules/occurrences` reports it. In `@clawboo/scheduler`, `nextOccurrence`, `probeCronSpec` and `occurrencesInWindows` take an optional IANA zone.
