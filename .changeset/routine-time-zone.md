---
'clawboo': patch
---

Routines run in a time zone you choose, one setting for every routine on the install and independent of the server process. They used to run in the process's zone, which in a container is UTC unless `TZ` is set, so a routine set for 9:00 ran at 9:00 UTC. The routine dialog now says which zone the time is in, with **Change** to pick another; it starts as the server's own zone, so an install that never sets one runs exactly as before. Changing it moves every armed routine's next run to the new zone, in the same write. A `once@` time typed in the dialog now needs a `Z` or an offset, because the browser and the server would otherwise each read it in their own zone. `GET` and `PUT /api/schedules/time-zone` read and set it, and `GET /api/schedules/occurrences` reports it. In `@clawboo/scheduler`, `nextOccurrence`, `probeCronSpec` and `occurrencesInWindows` take an optional IANA zone.
