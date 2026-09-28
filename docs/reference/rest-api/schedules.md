---
title: Schedules API
description: "REST reference for the unified scheduler: list, create, update, pause/resume, delete, and force-run schedules across two sources, and read a routine's run history."
---

REST surface for the unified scheduler: one merged read/write view over two [schedule sources](/concepts/scheduling): clawboo **Routines** (the `team-task` domain, fully managed) and the **OpenClaw Gateway cron** (the `runtime-own-life` domain, written through the Gateway's own operator RPC). A read always succeeds and reports per-source degradation as data; a write routes to the owning source by id and surfaces the typed scheduling errors as precise status codes.

<Note>
The two sources are never conflated. A Routine row schedules *team work* on a cadence, for any runtime class: a message to a team's lead (a team routine) or a board task for one agent (an agent routine). A Gateway-cron row schedules an OpenClaw agent's *own standalone life*. clawboo never registers team work into the Gateway cron, and never auto-creates own-life crons; the Routines view is an operator surface over them, not their owner.
</Note>

Every record carries a **composite `id`** of the form `<source>:<rawId>` (`clawboo-routine:<ledger-row-id>` or `openclaw-gateway-cron:<gateway-job-id>`). The `:id` path segment on the mutation routes is URL-decoded and parsed back to its owning source; the write routes there. An id that matches no source returns **404**. All POST/PATCH bodies are parsed by `express.json({ limit: '2mb' })`.

## Routes

| Method | Path                      | Summary                                                                  | Stream? |
| ------ | ------------------------- | ------------------------------------------------------------------------ | ------- |
| GET    | `/api/schedules`          | Merged list across both sources (degradation is data)                    | No      |
| POST   | `/api/schedules`          | Create a schedule (routed by `spec.source`)                              | No      |
| PATCH  | `/api/schedules/:id`      | Pause / resume, or patch cron spec / label / template / payload / target | No      |
| DELETE | `/api/schedules/:id`      | Remove a schedule                                                        | No      |
| POST   | `/api/schedules/:id/run`  | Force-fire now (enqueue-style ack)                                       | No      |
| GET    | `/api/schedules/:id/runs` | A Routine's recent fires, newest first                                   | No      |

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
  agentId: string            // the agent a fire runs on; '' for a team routine
  target?: 'team' | 'agent'  // Routine rows: who a fire goes to
  teamId?: string | null     // Routine rows: the team whose chat or board receives a fire
  teamName?: string          // display names resolved at read time; for a team routine,
  agentName?: string         //   agentName (and runtime) are the team's current lead's
  teamTaskId?: string        // set only for Routine rows bound to an existing board task
  label?: string
  description?: string       // Routine rows: the instructions each fire carries
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

The merged view. Fans `read()` across both sources and concatenates their records, then resolves each record's `teamName` and `agentName`. A team routine has no stored agent, so it reports the team's current lead (the agent its next fire would reach) as `agentName` and `runtime`. A source that fails or is disconnected does not fail the request; it contributes a degraded `sources[]` entry instead (a warm Gateway-cron cache is served stale; otherwise its rows are simply absent until reconnect). This route always returns **200**.

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

For a `clawboo-routine` create: the cron spec is probed (an unparseable spec throws), a task template is built from `label` + `taskTemplate` + `target` (the template's `title` defaults to the `label`, and its `description` is the instructions each fire sends), and the target is validated against the registry:

- **A team routine** (`target: 'team'`) needs a `teamId` naming a live, unarchived team. Its fires are posted into that team's chat for the team's lead, so the row stores no agent (`agentId` is ignored and reads back as `''`), and it cannot bind a `teamTaskId`.
- **An agent routine** (`target: 'agent'`, the default) needs an `agentId` naming a live, unarchived agent, and is filed on that agent's own team. A `teamId` is optional; when given it must match the agent's team (`null` for an agent on no team).

A target that fails these checks is a **400** with `code: "invalid_routine_target"`. A recurring spec bound to an existing `teamTaskId` is refused too (a bound task is claimable exactly once, so a recurring fire would park in `error` forever; bind only one-shot `once@<iso>` specs). Binding to a task already owned by another firing owner is the **409** de-dup refusal.

For an `openclaw-gateway-cron` create, the source calls `cron.add` with the job's `payload` (default `{ kind: 'agentTurn', message: label }`) and the session target that payload kind requires: `main` for a `systemEvent`, `isolated` for anything else. The Gateway accepts a mismatched pair but then skips every fire, so the pairing is never left to the caller.

- **Path/query params**: none.
- **Request body**: a `ScheduleCreateSpec`. `source`, `domain`, and `cronSpec` are required, plus a `teamId` for a team routine or an `agentId` for anything else; the rest are optional:

```ts
{
  source: 'clawboo-routine' | 'openclaw-gateway-cron'   // required
  domain: 'team-task' | 'runtime-own-life'              // required
  cronSpec: string                                      // required
  target?: 'team' | 'agent'    // Routine rows: who a fire goes to (default 'agent')
  agentId?: string             // required unless target is 'team'
  teamId?: string | null       // required for a team routine; must match the agent's team otherwise
  label?: string
  teamTaskId?: string | null   // agent routines: bind to an existing board task (the ownership-guard site)
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

**`400 Bad Request`**: the body is missing a required field, has an unknown `source`/`domain`/`target`, or fails a source-side validation. `code` is `invalid_body` for the shape check or a zod-rejected template, `invalid_cron_spec` for an unparseable cron spec, `invalid_routine_target` for a target that does not check out, or `bound_recurring_schedule` for a recurring spec bound to an existing task:

```json
{
  "error": "source, domain, cronSpec, and an agentId (or a teamId for a team routine) are required",
  "code": "invalid_body"
}
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
{ "error": "\"Ada\" is not on that team.", "code": "invalid_routine_target" }
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
# A team routine: post to the team chat every weekday at 9am
curl -X POST http://localhost:18790/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "clawboo-routine",
    "domain": "team-task",
    "target": "team",
    "teamId": "<team-id>",
    "cronSpec": "0 9 * * 1-5",
    "label": "Daily standup digest",
    "taskTemplate": { "description": "Summarize what the team finished yesterday." }
  }'

# An agent routine: a daily task for one agent
curl -X POST http://localhost:18790/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "clawboo-routine",
    "domain": "team-task",
    "target": "agent",
    "agentId": "<agent-id>",
    "cronSpec": "0 9 * * *",
    "label": "Inbox sweep",
    "taskTemplate": { "description": "Check the support inbox and draft replies to anything urgent." }
  }'
```

---

## `PATCH /api/schedules/:id`

Pauses/resumes a schedule, or patches its cron spec, label, task template, payload, or target. The body is one of two shapes; an unrecognized body returns **400**. The write routes to the source named in `:id`.

For a Routine: pause sets the row to `paused` (disarmed, `nextRunAt` cleared) and is legal from `idle`, `queued`, or `error`; resume re-arms it to `idle` with a freshly computed `nextRunAt` and is legal from `paused` or `error`. Neither is legal while a fire is in flight (`claimed` or `running`), since that fire settles the row itself. A cron-spec patch recomputes `nextRunAt` only for an already-armed (`idle`) row. A patch that sets `target`, `agentId`, or `teamId` re-points the Routine, and the resulting target is validated exactly like a create (a `target` inside `taskTemplate` counts as one too). A `teamTaskId` inside a template patch is ignored: a Routine binds to a board task only at registration, where the firing-owner guard runs. For the Gateway cron: pause/resume map to `cron.update { id, patch: { enabled } }` (there is no separate enable/disable method), and a patch maps to `cron.update { id, patch }` with the changed fields (a changed `payload` carries its matching session target).

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
    taskTemplate?: unknown        // Routine rows (e.g. { description } for new instructions)
    target?: 'team' | 'agent'     // Routine rows: re-point the routine
    agentId?: string | null       // Routine rows
    teamId?: string | null        // Routine rows
    payload?: unknown             // Gateway rows
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

**`400 Bad Request`**: the body is neither a valid `action` nor a `patch` object, a patched `cronSpec` is unparseable, or a re-pointed target does not check out (`invalid_routine_target`):

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

# Turn it into a team routine for another team
curl -X PATCH http://localhost:18790/api/schedules/clawboo-routine:<row-id> \
  -H 'Content-Type: application/json' \
  -d '{"patch":{"target":"team","teamId":"<team-id>","agentId":null}}'
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

Force-fires a schedule now. This is an enqueue-style acknowledgement, not a synchronous run: a Routine is moved to `queued` and the ticker, poked by the write, picks it up at once; the Gateway cron is told `cron.run { id, mode: 'force' }`. Only an `idle` Routine can be queued: a paused, errored, or already-running one returns **409**. Completion is observed elsewhere (the Routine's [run history](#get-apischedulesidruns), the obs event log, or Gateway cron-run polling), not in this response. The write routes to the source named in `:id`.

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

## `GET /api/schedules/:id/runs`

A Routine's recent fires, newest first, folded from the `routine_*` events in the obs event log (every one of them carries the Routine's `scheduledRunId`). An agent routine's fire carries the board task it created, resolved to that task's current title and status. The Gateway keeps its own run history, so a Gateway-cron id returns an empty list.

- **Path params**: `id` (composite schedule id; URL-decoded).
- **Query params**: `limit` (optional, default `10`, clamped to `1`–`50`).
- **Request body**: none.

### Responses

**`200 OK`**:

```ts
{
  runs: Array<{
    firedAt: number // epoch ms of the claim
    finishedAt: number | null // when the outcome was recorded
    status: 'running' | 'succeeded' | 'failed' | 'interrupted'
    error: string | null // the failure, for a failed fire
    taskId: string | null // the board task an agent fire created; null for a team fire
    dispatchPath: string | null // 'team-chat' | 'one-shot' | 'connected'
    targetAgentId: string | null // a team fire's recipient: the lead the message went to
    task: { id: string; title: string; status: string } | null
  }>
}
```

A fire reads `interrupted` when it never recorded an outcome: the next fire began without one, or the Routine is no longer queued, claimed, or running. Both mean the server stopped during that fire. A team fire `succeeded` once the lead's turn started; the team's work then continues in the chat.

**`404 Not Found`**: `:id` is not a composite schedule id, or names no Routine:

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`500 Internal Server Error`**: any other throw:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/schedules/clawboo-routine:<row-id>/runs?limit=5'
```

---

## Error envelope

Every error response on these routes is the standard envelope plus a structural `code`: `{ error: string, code?: string }`. The `code` is a stable, branch-on-able discriminant (never parse the message prose):

| `code`                        | Status | Meaning                                                                |
| ----------------------------- | ------ | ---------------------------------------------------------------------- |
| `invalid_body`                | 400    | The request body failed the shape check                                |
| `invalid_cron_spec`           | 400    | The cron spec parses as neither a cron expression nor `once@<iso>`     |
| `bound_recurring_schedule`    | 400    | A recurring spec was bound to an existing one-shot-only team task      |
| `invalid_routine_target`      | 400    | A Routine's team or agent is missing, archived, or does not match      |
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
- [Routines](/using/routines), the view over this surface
- [The board](/concepts/the-board), `teamTaskId`, atomic claim, the one-firing-owner guard
- [@clawboo/scheduler](/reference/packages/scheduler), `ScheduleRecord`, the source trait, the multiplexer
- [System API](/reference/rest-api/system), OpenClaw Gateway lifecycle (the cron source's backing connection)
- [REST API overview](/reference/rest-api/index)
