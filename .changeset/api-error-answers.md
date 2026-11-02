---
'clawboo': patch
---

Several API routes answer with the status and body their documentation describes.

**Schedules.** A cron spec that does not parse answers `400` with `code: "invalid_cron_spec"` instead of `invalid_body`. Changing, pausing, resuming, deleting or running an OpenClaw Gateway cron job the Gateway does not have answers `404 unknown_schedule` instead of `500`. A create, change, pause or resume answer carries `teamName` and `agentName`, and a team routine's lead `runtime`, the same as the list. Pausing a Routine clears its `nextRunAt`, so a paused Routine no longer shows a next run; resuming sets a new one.

**Other routes.**

- `POST /api/exec-allowlist/revoke` answers `502` only when the Gateway call fails. A failure inside Clawboo, such as a database read, is a `500`.
- `POST /api/capabilities/install` answers `422` with the scan's `findings` when the injection scan blocks the install, instead of a `500`.
- `POST /api/agents/:agentId/screenshot/capture` answers a failed capture with a JSON `500` instead of an HTML error page.
- `POST /api/runtimes/clawboo-mock/run` runs a task on the fault-injection runtime when `CLAWBOO_ENABLE_MOCK_RUNTIME=1` is set, instead of answering `404`.
