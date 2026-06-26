---
title: Schedules API
description: 'REST reference for the unified scheduler: list, create, update, pause/resume, delete, and force-run schedules across two sources.'
---

REST surface for the unified scheduler: one merged read/write view over two [schedule sources](/concepts/scheduling): clawboo **Routines** (the `team-task` domain, fully managed) and the **OpenClaw Gateway cron** (the `runtime-own-life` domain, written through the Gateway's own operator RPC). A read always succeeds and reports per-source degradation as data; a write routes to the owning source by id and surfaces the typed scheduling errors as precise status codes.

<Note>
The two sources are never conflated. A Routine row schedules *team work* (a board task fired on a cadence, for any runtime class); a Gateway-cron row schedules an OpenClaw agent's *own standalone life*. clawboo never registers a team task into the Gateway cron, and never auto-creates own-life crons; the Scheduler tab is an operator surface over them, not their owner.
</Note>

Every record carries a **composite `id`** of the form `<source>:<rawId>` (`clawboo-routine:<ledger-row-id>` or `openclaw-gateway-cron:<gateway-job-id>`). The `:id` path segment on the mutation routes is URL-decoded and parsed back to its owning source; the write routes there. An id that matches no source returns **404**. All POST/PATCH bodies are parsed by `express.json({ limit: '2mb' })`.

## Routes

| Method | Path                     | Summary                                                         | Stream? |
| ------ | ------------------------ | --------------------------------------------------------------- | ------- |
| GET    | `/api/schedules`         | Merged list across both sources (degradation is data)           | No      |
| POST   | `/api/schedules`         | Create a schedule (routed by `spec.source`)                     | No      |
| PATCH  | `/api/schedules/:id`     | Pause / resume, or patch cron spec / label / template / payload | No      |
| DELETE | `/api/schedules/:id`     | Remove a schedule                                               | No      |
| POST   | `/api/schedules/:id/run` | Force-fire now (enqueue-style ack)                              | No      |

---

## The `ScheduleRecord` shape

Every source projects its rows into one normalized record. This is the element type of the `schedules[]` array on `GET`, and the value returned (under `schedule`) on a successful create/update/pause/resume.

```ts
{
  id: string                 // composite `${source}:${sourceScheduleId}` — opaque to the UI
  sourceScheduleId: string   // the raw id inside the owning system
  runtime: string            // runtime the schedule targets ('openclaw' | 'clawboo-native' | …)
  owner: string              // = scheduledBy: which engine FIRES it ('clawboo' | 'openclaw' | …)
  source: 'clawboo-routine' | 'openclaw-gateway-cron'
  agentId: string
  teamTaskId?: string        // set only for team-task rows bound to an existing board task
  label?: string
  cronSpec: string           // a cron expression, `once@<iso>`, `every:<ms>[@anchor:<ms>]`, or `at:<iso>`
  nextRunAt: number | null   // epoch ms; null when disarmed / will never fire again
  lastRunAt?: number
  lastError?: string
  status: 'queued' | 'claimed' | 'running' | 'idle' | 'paused' | 'error'
  manageability: 'managed' | 'external-write' | 'observe-only'
  domain: 'team-task' | 'runtime-own-life'
  tenantId: string | null    // dormant multi-tenant seam — always null today
}
```

The two live sources are fixed:

| `source`                | `domain`           | `manageability`  | `owner` of its rows                        | Backed by                                 |
| ----------------------- | ------------------ | ---------------- | ------------------------------------------ | ----------------------------------------- |
| `clawboo-routine`       | `team-task`        | `managed`        | the ledger row's `scheduledBy` (`clawboo`) | the `scheduled_runs` SQLite ledger        |
| `openclaw-gateway-cron` | `runtime-own-life` | `external-write` | `openclaw`                                 | the Gateway cron over the operator WS-RPC |

<Note>
There is no third source. Claude Code, Codex, Hermes, and clawboo-native have no live native scheduler; scheduling any of them *is* a clawboo Routine.
</Note>

---

## `GET /api/schedules`

The merged view. Fans `read()` across both sources and concatenates their records. A source that fails or is disconnected does not fail the request; it contributes a degraded `sources[]` entry instead (a warm Gateway-cron cache is served stale; otherwise its rows are simply absent until reconnect). This route always returns **200**.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the merged records plus a per-source status array:

```ts
{
  schedules: ScheduleRecord[]
  sources: Array<{
    sourceId: 'clawboo-routine' | 'openclaw-gateway-cron'
    ok: boolean
    degraded: boolean
    reason?: string   // e.g. 'gateway_disconnected' | 'stale_cache'
    at: number        // epoch ms of this read
  }>
}
```

The Routines source reports `{ ok: true, degraded: false }`. The Gateway-cron source reports `{ ok: false, degraded: true, reason: 'gateway_disconnected' }` (no cache) or `reason: 'stale_cache'` (warm cache) when its operator connection is down.

### Example

```bash
curl http://localhost:18790/api/schedules
```

---

## `POST /api/schedules`

Creates a schedule. The body is a `ScheduleCreateSpec`; the multiplexer routes the write to `spec.source`. Before the source is touched it enforces, in order: an observe-only source rejects with **403**, and a `team-task` create aimed at a `runtime-own-life` source rejects with **422** (defense-in-depth; the Gateway-cron source refuses it too). The owning source then performs its own validation.

For a `clawboo-routine` create: the cron spec is probed (an unparseable spec throws), a task template is built from `label` + `taskTemplate`, and a recurring spec bound to an existing `teamTaskId` is refused (a bound task is claimable exactly once, so a recurring fire would park in `error` forever; bind only one-shot `once@<iso>` specs). Binding to a task already owned by another firing owner is the **409** de-dup refusal.

- **Path/query params**: none.
- **Request body**: a `ScheduleCreateSpec`. `source`, `domain`, `agentId`, and `cronSpec` are required; the rest are optional:

```ts
{
  source: 'clawboo-routine' | 'openclaw-gateway-cron'   // required
  domain: 'team-task' | 'runtime-own-life'              // required
  agentId: string                                       // required
  cronSpec: string                                      // required
  label?: string
  teamId?: string | null
  teamTaskId?: string | null   // Routine rows: bind to an existing board task (the ownership-guard site)
  taskTemplate?: unknown       // Routine rows: the ledger task-template object (validated by the source)
  payload?: unknown            // Gateway rows: the cron payload (e.g. { kind: 'agentTurn', message })
  tenantId?: string | null     // dormant multi-tenant seam
}
```

### Responses

**`201 Created`**: the schedule was registered:

```ts
{
  schedule: ScheduleRecord
}
```

**`400 Bad Request`**: the body is missing a required field, has an unknown `source`/`domain`, or fails a source-side validation. `code` is `invalid_body` for the shape check, `invalid_cron_spec` for an unparseable cron spec, `bound_recurring_schedule` for a recurring spec bound to an existing task, or `invalid task template` (with no `code`) for a zod-rejected template:

```json
{ "error": "source, domain, agentId, and cronSpec are required", "code": "invalid_body" }
```

```json
{ "error": "Invalid cron spec \"* * *\": ...", "code": "invalid_cron_spec" }
```

```json
{
  "error": "A recurring schedule (\"0 9 * * *\") cannot bind to existing team task <id> — a bound task is claimable once, so use a one-shot (once@<iso>) spec",
  "code": "bound_recurring_schedule"
}
```

```json
{ "error": "invalid task template", "code": "invalid_body" }
```

**`403 Forbidden`**: the target source is `observe-only` (no live source is observe-only today, but the gate exists):

```json
{
  "error": "Schedule source \"<id>\" (observe-only) does not support \"create\"",
  "code": "unsupported_schedule_write"
}
```

**`404 Not Found`**: `spec.source` matches no registered source:

```json
{ "error": "Unknown schedule \"<create>\"", "code": "unknown_schedule" }
```

**`409 Conflict`**: the bound `teamTaskId` is already scheduled by a different firing owner. This is a data refusal; do not retry:

```json
{
  "error": "Already scheduled by \"<owner>\" (team task <id>) — never retry this refusal",
  "code": "duplicate_firing_owner"
}
```

**`422 Unprocessable Entity`**: a `domain: 'team-task'` create was aimed at a `runtime-own-life` source (the Gateway cron):

```json
{
  "error": "A team-task schedule cannot be registered into \"openclaw-gateway-cron\" — team-task cadence belongs to the Routines ledger",
  "code": "team_task_domain_violation"
}
```

**`503 Service Unavailable`**: the target is the Gateway-cron source and its operator connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other throw:

```json
{ "error": "<message>" }
```

### Example

```bash
# Create a daily Routine (team-task) for a native agent
curl -X POST http://localhost:18790/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "clawboo-routine",
    "domain": "team-task",
    "agentId": "<agent-id>",
    "cronSpec": "0 9 * * *",
    "label": "Daily standup digest",
    "taskTemplate": { "title": "Daily standup digest", "kind": "code" }
  }'
```

---

## `PATCH /api/schedules/:id`

Pauses/resumes a schedule, or patches its cron spec, label, task template, or payload. The body is one of two shapes; an unrecognized body returns **400**. The write routes to the source named in `:id`.

For a Routine: pause sets the row to `paused` (disarmed, `nextRunAt` cleared); resume re-arms it to `idle` with a freshly computed `nextRunAt`; a cron-spec patch recomputes `nextRunAt` only for an already-armed (`idle`) row. For the Gateway cron: pause/resume map to `cron.update { id, enabled }` (there is no separate enable/disable method), and a patch maps to `cron.update` with the changed fields.

- **Path params**: `id` (composite schedule id; URL-decoded; 404 on no-source-match).
- **Request body**: exactly one of:

```ts
{
  action: 'pause' | 'resume'
}
```

```ts
{
  patch: {
    cronSpec?: string
    label?: string
    taskTemplate?: unknown   // Routine rows
    payload?: unknown        // Gateway rows
  }
}
```

### Responses

**`200 OK`**: the schedule was updated; the fresh record is returned (a Gateway-cron update may return `schedule: null` when the best-effort read-back can't reload the job):

```ts
{
  schedule: ScheduleRecord | null
}
```

**`400 Bad Request`**: the body is neither a valid `action` nor a `patch` object, or a patched `cronSpec` is unparseable:

```json
{ "error": "body needs { action: 'pause' | 'resume' } or { patch }", "code": "invalid_body" }
```

```json
{ "error": "Invalid cron spec \"...\": ...", "code": "invalid_cron_spec" }
```

**`403 Forbidden`**: the target source is `observe-only`:

```json
{
  "error": "Schedule source \"<id>\" (observe-only) does not support \"pause\"",
  "code": "unsupported_schedule_write"
}
```

**`404 Not Found`**: `:id` matches no source, or the id is unknown within its source:

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`409 Conflict`**: the requested pause/resume is illegal from the row's current status (Routine state machine):

```json
{ "error": "Illegal schedule transition error → idle", "code": "illegal_schedule_transition" }
```

**`503 Service Unavailable`**: the Gateway-cron source's operator connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other throw:

```json
{ "error": "<message>" }
```

### Example

```bash
# Pause a Routine
curl -X PATCH http://localhost:18790/api/schedules/clawboo-routine:<row-id> \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'

# Change its cron spec
curl -X PATCH http://localhost:18790/api/schedules/clawboo-routine:<row-id> \
  -H 'Content-Type: application/json' \
  -d '{"patch":{"cronSpec":"0 8 * * 1-5"}}'
```

---

## `DELETE /api/schedules/:id`

Removes a schedule. For a Routine it deletes the ledger row; for the Gateway cron it calls `cron.remove`. The write routes to the source named in `:id`.

- **Path params**: `id` (composite schedule id; URL-decoded; 404 on no-source-match).
- **Request body**: none.

### Responses

**`200 OK`**: the schedule was removed:

```json
{ "ok": true }
```

**`403 Forbidden`**: the target source is `observe-only`:

```json
{
  "error": "Schedule source \"<id>\" (observe-only) does not support \"remove\"",
  "code": "unsupported_schedule_write"
}
```

**`404 Not Found`**: `:id` matches no source, or the id is unknown within its source:

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`503 Service Unavailable`**: the Gateway-cron source's operator connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other throw:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X DELETE http://localhost:18790/api/schedules/openclaw-gateway-cron:<job-id>
```

---

## `POST /api/schedules/:id/run`

Force-fires a schedule now. This is an enqueue-style acknowledgement, not a synchronous run: a Routine is moved to `queued` (the ticker picks it up); the Gateway cron is told `cron.run { id, mode: 'force' }`. Completion is observed elsewhere (the obs event log / Gateway cron-run polling), not in this response. The write routes to the source named in `:id`.

- **Path params**: `id` (composite schedule id; URL-decoded; 404 on no-source-match).
- **Request body**: none.

### Responses

**`202 Accepted`**: the fire was enqueued:

```json
{ "ok": true }
```

**`403 Forbidden`**: the target source is `observe-only`:

```json
{
  "error": "Schedule source \"<id>\" (observe-only) does not support \"run\"",
  "code": "unsupported_schedule_write"
}
```

**`404 Not Found`**: `:id` matches no source, or the id is unknown within its source:

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`409 Conflict`**: a Routine could not be queued from its current status:

```json
{ "error": "Illegal schedule transition <status> → queued", "code": "illegal_schedule_transition" }
```

**`503 Service Unavailable`**: the Gateway-cron source's operator connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other throw:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/schedules/clawboo-routine:<row-id>/run
```

---

## Error envelope

Every error response on these routes is the standard envelope plus a structural `code`: `{ error: string, code?: string }`. The `code` is a stable, branch-on-able discriminant (never parse the message prose):

| `code`                        | Status | Meaning                                                                |
| ----------------------------- | ------ | ---------------------------------------------------------------------- |
| `invalid_body`                | 400    | The request body failed the shape check                                |
| `invalid_cron_spec`           | 400    | The cron spec parses as neither a cron expression nor `once@<iso>`     |
| `bound_recurring_schedule`    | 400    | A recurring spec was bound to an existing one-shot-only team task      |
| `unsupported_schedule_write`  | 403    | The target source's manageability tier forbids the action              |
| `unknown_schedule`            | 404    | The composite id matched no source, or is unknown within it            |
| `duplicate_firing_owner`      | 409    | The bound team task already has a different firing owner; do not retry |
| `illegal_schedule_transition` | 409    | The pause/resume/run is illegal from the current status                |
| `team_task_domain_violation`  | 422    | A `team-task` create was aimed at a `runtime-own-life` source          |
| `schedule_source_unavailable` | 503    | A write hit a source whose backing connection is down (Gateway cron)   |
| _(none)_                      | 500    | Any other throw                                                        |

A zod-rejected task template returns `{ error: "invalid task template", code: "invalid_body" }`.

## See also

- [Scheduling (Routines): team-task cron vs runtime-own-life cron](/concepts/scheduling)
- [Recurring team work (Routines how-to)](/guides/recurring-team-work)
- [Scheduler tab](/using/scheduler), the UI over this surface
- [The board](/concepts/the-board), `teamTaskId`, atomic claim, the one-firing-owner guard
- [@clawboo/scheduler](/reference/packages/scheduler), `ScheduleRecord`, the source trait, the multiplexer
- [System API](/reference/rest-api/system), OpenClaw Gateway lifecycle (the cron source's backing connection)
- [REST API overview](/reference/rest-api/index)
