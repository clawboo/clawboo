---
title: 'Schedules API'
description: 'REST reference for Routines and OpenClaw cron jobs: list, create, change, pause, resume, delete and run schedules, and read run history and upcoming runs.'
keywords:
  ['routines', 'scheduler', 'schedules', 'cron', 'gateway cron', 'occurrences', 'run history']
---

Use these routes to read and change everything that runs on a schedule. One list covers two sources: Clawboo's own [Routines](/using/routines), which schedule team work, and the OpenClaw Gateway's cron jobs, which run an OpenClaw agent's own work outside any team. The schedule list always answers and reports a source that is down as data. A write goes to the source that owns the schedule, and its errors come back as precise status codes with a stable `code`.

<Note>

The two sources stay separate. A Routine schedules team work on any runtime: a message to a team's lead (a team routine) or a board task for one agent (an agent routine). A Gateway cron job schedules an OpenClaw agent's own work. Clawboo never puts team work into the Gateway's cron and never creates Gateway cron jobs by itself; the Routines view shows them and lets you change them.

</Note>

Every schedule has a **composite `id`** of the form `<source>:<rawId>`: `clawboo-routine:<routine-id>` or `openclaw-gateway-cron:<gateway-job-id>`. The `:id` path segment is URL-decoded and sent to the source it names; an id that matches no source answers **404**. Request bodies are JSON (up to 2 MB). Every route here is on the general [rate limit](/reference/rest-api/index#rate-limits) (3,000 requests a minute per client address). The `curl` examples assume the access gate is off; with `STUDIO_ACCESS_TOKEN` set, add `-b 'clawboo_access=<token>'` (see [Authentication](/reference/rest-api/index#authentication)).

## Routes

| Method | Path                         | Summary                                                                  | Stream? |
| ------ | ---------------------------- | ------------------------------------------------------------------------ | ------- |
| GET    | `/api/schedules`             | Every schedule from both sources (a source that is down is reported)     | No      |
| POST   | `/api/schedules`             | Create a schedule in the source named by `source`                        | No      |
| PATCH  | `/api/schedules/:id`         | Pause, resume, or change the cron spec, label, template, payload, target | No      |
| DELETE | `/api/schedules/:id`         | Remove a schedule                                                        | No      |
| POST   | `/api/schedules/:id/run`     | Run it now (queued, answered with 202)                                   | No      |
| GET    | `/api/schedules/:id/runs`    | A Routine's recent runs, newest first                                    | No      |
| GET    | `/api/schedules/occurrences` | Upcoming Routine runs, counted per time window you name                  | No      |

---

## The `ScheduleRecord` shape

Both sources describe their schedules in one shape. It is the element type of `schedules[]` on `GET`, and the `schedule` returned by a create, change, pause or resume.

```ts
{
  id: string                 // composite <source>:<rawId>; treat it as opaque
  sourceScheduleId: string   // the raw id inside the owning source
  runtime: string            // the runtime a run uses ('openclaw', 'clawboo-native', ...); 'unknown' when there is
                             //   no agent to read it from (see the note on team routines below)
  owner: string              // which engine runs it ('clawboo' or 'openclaw')
  source: 'clawboo-routine' | 'openclaw-gateway-cron'
  agentId: string            // the agent a run uses; '' for a team routine
  target?: 'team' | 'agent'  // Routines: who a run goes to
  teamId?: string | null     // Routines: the team whose chat or board receives a run
  teamName?: string          // display names, filled in by GET /api/schedules and the occurrences
  agentName?: string         //   route only; for a team routine, agentName (and runtime) are the lead's
  teamTaskId?: string        // only for a Routine bound to an existing board task
  label?: string
  description?: string       // Routines: the instructions each run carries
  cronSpec: string           // a cron expression, `once@<iso>`, `every:<ms>[@anchor:<ms>]` or `at:<iso>`;
                             //   a Gateway cron expression with a time zone reads `<expr>@tz:<zone>`
  nextRunAt: number | null   // epoch ms of the next run; null when none is scheduled. A paused Routine
                             //   keeps the value it had when paused, but does not run until resumed
  lastRunAt?: number
  lastError?: string
  status: 'queued' | 'claimed' | 'running' | 'idle' | 'paused' | 'error'
  manageability: 'managed' | 'external-write' | 'observe-only'
  domain: 'team-task' | 'runtime-own-life'
  tenantId: string | null    // always null
}
```

`domain` says what a schedule is for: `team-task` is team work that Clawboo schedules (Routines), and `runtime-own-life` is an OpenClaw agent's own job in the Gateway's cron. `manageability` says who owns it: `managed` means Clawboo owns and runs it, `external-write` means the Gateway owns and runs it and Clawboo changes it through the Gateway, and `observe-only` (no source uses it today) would be read-only.

A team routine stores no agent (`agentId` is `''`). `GET /api/schedules` and the occurrences route fill in `teamName` and `agentName`, and for a team routine they take `agentName` and `runtime` from the team's current lead. The `schedule` in a create, change, pause or resume answer has no names, and a team routine there reads `runtime: 'unknown'`. An agent routine whose agent is gone reads `runtime: 'unknown'` everywhere.

| `source`                | `domain`           | `manageability`  | `owner`    | Backed by                                                    |
| ----------------------- | ------------------ | ---------------- | ---------- | ------------------------------------------------------------ |
| `clawboo-routine`       | `team-task`        | `managed`        | `clawboo`  | Clawboo's database (the `scheduled_runs` table)              |
| `openclaw-gateway-cron` | `runtime-own-life` | `external-write` | `openclaw` | The Gateway's cron, through Clawboo's own Gateway connection |

<Note>

There is no third source. Claude Code, Codex, Hermes and Clawboo Native have no scheduler of their own that Clawboo uses; scheduling any of them is a Routine.

</Note>

---

## `GET /api/schedules`

Every schedule from both sources, with each one's `teamName` and `agentName` filled in. A team routine stores no agent, so it reports the team's current lead (the agent its next run would reach) as `agentName` and `runtime`. A source that fails or is disconnected does not fail the request: it adds a degraded entry to `sources[]`. A Gateway cron list read earlier is served from its cache; with no cache, its jobs are absent until the Gateway reconnects. This route always answers **200**.

- **Path/query params**: none.
- **Request body**: none.

### Responses

**`200 OK`**: the schedules plus one status entry per source:

```ts
{
  schedules: ScheduleRecord[]
  sources: Array<{
    sourceId: 'clawboo-routine' | 'openclaw-gateway-cron'
    ok: boolean
    degraded: boolean
    reason?: string // 'gateway_disconnected', 'stale_cache', or an error message
    at: number      // epoch ms of this read
  }>
}
```

The Routines source reports `{ ok: true, degraded: false }`. When its Gateway connection is down, the Gateway cron source reports `{ ok: false, degraded: true, reason: 'gateway_disconnected' }` with no cache, or `reason: 'stale_cache'` when it serves cached jobs.

### Example

```bash
curl http://localhost:18790/api/schedules
```

---

## `POST /api/schedules`

Creates a schedule in the source named by `source`. Before the source is touched, two checks run in order: a read-only (`observe-only`) source answers **403**, and a `domain: 'team-task'` create aimed at the Gateway cron answers **422** (the Gateway cron source refuses it too). The source then runs its own checks.

For a `clawboo-routine` create, the cron spec is checked (a spec that does not parse is a **400**), and the Routine's task template is built from `label`, `taskTemplate` and `target`. The template's `title` defaults to `label` (or `Scheduled team task`), and its `description` is the instructions each run carries. The target is checked too:

- **A team routine** (`target: 'team'`) needs a `teamId` naming a live, unarchived team. Its runs are posted into that team's chat for the team's lead, so it stores no agent (`agentId` is ignored and reads back as `''`), and it cannot bind a `teamTaskId`.
- **An agent routine** (`target: 'agent'`, the default) needs an `agentId` naming a live, unarchived agent, and is filed on that agent's team. A `teamId` is optional; when sent, it must match the agent's team (`null` for an agent on no team).

A target that fails these checks is a **400** with `code: "invalid_routine_target"`. A recurring spec bound to an existing `teamTaskId` is refused too: a bound task can be claimed only once, so a recurring run would park the Routine in `error`. Bind only one-shot `once@<iso>` specs. Binding a task that another engine already schedules is the **409** `duplicate_firing_owner` refusal.

For an `openclaw-gateway-cron` create, Clawboo calls the Gateway's `cron.add` with the job's `payload` (default `{ kind: 'agentTurn', message: label }`, with `'Scheduled wake'` when there is no `label`) and the session target that payload needs: `main` for a `systemEvent`, `isolated` for anything else. The Gateway accepts a mismatched pair but then skips every run, so Clawboo always picks the pair itself.

- **Path/query params**: none.
- **Request body**: a `ScheduleCreateSpec`. `source`, `domain` and `cronSpec` are required, plus a `teamId` for a team routine or an `agentId` for anything else:

```ts
{
  source: 'clawboo-routine' | 'openclaw-gateway-cron' // required
  domain: 'team-task' | 'runtime-own-life'            // required
  cronSpec: string                                    // required
  target?: 'team' | 'agent'    // Routines: who a run goes to (default 'agent')
  agentId?: string             // required unless target is 'team'
  teamId?: string | null       // required for a team routine; must match the agent's team otherwise
  label?: string
  teamTaskId?: string | null   // agent routines: bind to an existing board task (one-shot specs only)
  taskTemplate?: unknown       // Routines: the task template, for example { description }
  payload?: unknown            // Gateway jobs: the cron payload, for example { kind: 'agentTurn', message }
  tenantId?: string | null     // unused
}
```

### Responses

**`201 Created`**: the schedule was created:

```ts
{
  schedule: ScheduleRecord
}
```

**`400 Bad Request`**: a required field is missing, `source`, `domain` or `target` is unknown, or a source check failed. `code` is `invalid_body` for the shape check, a cron spec that does not parse, or an invalid task template; `invalid_routine_target` for a target that does not check out; and `bound_recurring_schedule` for a recurring spec bound to an existing task. Messages on this page that contain an em dash show it as the JSON escape `\u2014`:

```json
{
  "error": "source, domain, cronSpec, and an agentId (or a teamId for a team routine) are required",
  "code": "invalid_body"
}
```

```json
{ "error": "Invalid cron spec \"* * *\": <detail>", "code": "invalid_body" }
```

```json
{ "error": "invalid task template", "code": "invalid_body" }
```

```json
{ "error": "\"Ada\" is not on that team.", "code": "invalid_routine_target" }
```

```json
{
  "error": "A recurring schedule (\"0 9 * * *\") cannot bind to existing team task <id> \u2014 a bound task is claimable once, so use a one-shot (once@<iso>) spec",
  "code": "bound_recurring_schedule"
}
```

**`403 Forbidden`**: the target source is `observe-only` (no source is today, but the check exists):

```json
{
  "error": "Schedule source \"<id>\" (observe-only) does not support \"create\"",
  "code": "unsupported_schedule_write"
}
```

**`404 Not Found`**: the `teamTaskId` you bound names no board task:

```json
{ "error": "Unknown schedule \"<teamTaskId>\"", "code": "unknown_schedule" }
```

**`409 Conflict`**: the bound `teamTaskId` is already scheduled by another engine. Treat it as data and do not retry:

```json
{
  "error": "Already scheduled by \"<owner>\" (team task <id>) \u2014 never retry this refusal",
  "code": "duplicate_firing_owner"
}
```

**`422 Unprocessable Entity`**: a `domain: 'team-task'` create was aimed at the Gateway cron:

```json
{
  "error": "A team-task schedule cannot be registered into \"openclaw-gateway-cron\" \u2014 team-task cadence belongs to the Routines ledger",
  "code": "team_task_domain_violation"
}
```

**`503 Service Unavailable`**: the target is the Gateway cron and Clawboo's Gateway connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other error:

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

Pauses or resumes a schedule, or changes its cron spec, label, task template, payload or target. The body takes one of two shapes; a body with neither is a **400**, and a body with both runs `action` and ignores `patch`. The change goes to the source named in `:id`.

For a Routine:

- **Pause and resume** follow the table below. A paused Routine does not run until you resume it.
- **A cron spec change** recomputes `nextRunAt` for an `idle` Routine and sets it to `null` for any other. A paused or errored Routine gets a new `nextRunAt` when you resume it.
- **A change to `target`, `agentId` or `teamId`** points the Routine somewhere else, and the new target is checked exactly as on create. A `target` inside `taskTemplate` counts as one too.
- **A `teamTaskId` inside a template change** is ignored: a Routine binds to a board task only when it is created, where the check for another engine runs.

| Action   | Allowed when the Routine is                   | Result                                                    |
| -------- | --------------------------------------------- | --------------------------------------------------------- |
| `pause`  | `idle`, `queued`, `error` or already `paused` | `paused`; it does not run until resumed                   |
| `resume` | `paused`, `error` or already `idle`           | `idle`, a newly computed `nextRunAt`, `lastError` cleared |
| either   | `claimed` or `running`                        | **409**: the run in progress settles it                   |

Pausing a paused Routine changes nothing, and resuming an idle one only recomputes its `nextRunAt`; both answer **200**. Resuming a `queued` Routine is a **409**.

For a Gateway cron job:

- **Pause and resume** become the Gateway's `cron.update { id, patch: { enabled } }` (the Gateway has no separate enable method).
- **A change** becomes `cron.update { id, patch }` with the changed `label` (as the job's name), `cronSpec` and `payload`; the Routine-only fields are ignored. A changed `payload` carries the session target it needs, as on create.
- **The job id is not checked by Clawboo.** It goes to the Gateway as is, and a Gateway error (for example an unknown job) answers **500** with the Gateway's message, not **404**. The same holds for delete and run.

- **Path params**: `id` (composite schedule id).
- **Request body**: one of:

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
    taskTemplate?: unknown        // Routines, e.g. { description } for new instructions
    target?: 'team' | 'agent'     // Routines: point the Routine somewhere else
    agentId?: string | null       // Routines
    teamId?: string | null        // Routines
    payload?: unknown             // Gateway jobs
  }
}
```

### Responses

**`200 OK`**: the schedule was changed; the updated record is returned. A Gateway job can come back as `schedule: null` when it cannot be read back right after the change:

```ts
{
  schedule: ScheduleRecord | null
}
```

**`400 Bad Request`**: the body is neither a valid `action` nor a `patch` object, a changed `cronSpec` does not parse, the template is invalid, or a changed target does not check out (`invalid_routine_target`):

```json
{ "error": "body needs { action: 'pause' | 'resume' } or { patch }", "code": "invalid_body" }
```

```json
{ "error": "Invalid cron spec \"0 99 * * *\": <detail>", "code": "invalid_body" }
```

**`403 Forbidden`**: the target source is `observe-only`:

```json
{
  "error": "Schedule source \"<id>\" (observe-only) does not support \"pause\"",
  "code": "unsupported_schedule_write"
}
```

**`404 Not Found`**: `:id` matches no source, or names a Routine that does not exist (an unknown Gateway job id is a **500**, see above):

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`409 Conflict`**: the pause or resume is not allowed from the Routine's current status:

```json
{ "error": "Illegal schedule transition running → paused", "code": "illegal_schedule_transition" }
```

**`503 Service Unavailable`**: the target is a Gateway job and Clawboo's Gateway connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other error:

```json
{ "error": "<message>" }
```

### Example

```bash
# Pause a Routine
curl -X PATCH http://localhost:18790/api/schedules/clawboo-routine:<routine-id> \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'

# Change its cron spec
curl -X PATCH http://localhost:18790/api/schedules/clawboo-routine:<routine-id> \
  -H 'Content-Type: application/json' \
  -d '{"patch":{"cronSpec":"0 8 * * 1-5"}}'

# Turn it into a team routine for another team
curl -X PATCH http://localhost:18790/api/schedules/clawboo-routine:<routine-id> \
  -H 'Content-Type: application/json' \
  -d '{"patch":{"target":"team","teamId":"<team-id>","agentId":null}}'
```

---

## `DELETE /api/schedules/:id`

Removes a schedule: a Routine is deleted from Clawboo's database, and a Gateway job is removed with the Gateway's `cron.remove`.

- **Path params**: `id` (composite schedule id).
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

**`404 Not Found`**: `:id` matches no source, or names a Routine that does not exist (an unknown Gateway job id is a **500**, see PATCH):

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`503 Service Unavailable`**: the target is a Gateway job and Clawboo's Gateway connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other error:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X DELETE http://localhost:18790/api/schedules/openclaw-gateway-cron:<job-id>
```

---

## `POST /api/schedules/:id/run`

Runs a schedule now. The answer only says the run was queued; it does not wait for the run. A Routine moves to `queued` and Clawboo's scheduler picks it up at once; a Gateway job gets the Gateway's `cron.run { id, mode: 'force' }`. Only an `idle` Routine can be queued: a paused, errored, queued, claimed or running one answers **409**. Follow the result in the Routine's run history (`GET /api/schedules/:id/runs`), the event log, or OpenClaw's own cron history.

- **Path params**: `id` (composite schedule id).
- **Request body**: none.

### Responses

**`202 Accepted`**: the run was queued:

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

**`404 Not Found`**: `:id` matches no source, or names a Routine that does not exist (an unknown Gateway job id is a **500**, see PATCH):

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`409 Conflict`**: the Routine is not `idle`:

```json
{ "error": "Illegal schedule transition paused → queued", "code": "illegal_schedule_transition" }
```

**`503 Service Unavailable`**: the target is a Gateway job and Clawboo's Gateway connection is down:

```json
{ "error": "gateway_disconnected", "code": "schedule_source_unavailable" }
```

**`500 Internal Server Error`**: any other error:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/schedules/clawboo-routine:<routine-id>/run
```

---

## `GET /api/schedules/:id/runs`

A Routine's recent runs, newest first, built from the Routine's events in the event log. An agent routine's run carries the board task it created, with that task's current title and status. The Gateway keeps its own run history, so a Gateway job id returns an empty list.

- **Path params**: `id` (composite schedule id).
- **Query params**: `limit` (optional, default `10`, kept between 1 and 50).
- **Request body**: none.

### Responses

**`200 OK`**:

```ts
{
  runs: Array<{
    firedAt: number // epoch ms when the run was claimed
    finishedAt: number | null // when its outcome was recorded
    status: 'running' | 'succeeded' | 'failed' | 'interrupted'
    error: string | null // why a failed run failed
    taskId: string | null // the board task an agent routine's run created; null for a team routine
    dispatchPath: string | null // 'team-chat' | 'one-shot' | 'connected'
    targetAgentId: string | null // a team routine's recipient: the lead the message went to
    task: { id: string; title: string; status: string } | null
  }>
}
```

A run reads `interrupted` when it never recorded an outcome: the next run began without one, or the Routine is no longer queued, claimed or running. Either way the server stopped during that run. A team routine's run `succeeded` once the lead's turn started; the team's work then continues in the chat.

**`404 Not Found`**: `:id` is not a composite schedule id, or names no Routine:

```json
{ "error": "Unknown schedule \"<id>\"", "code": "unknown_schedule" }
```

**`500 Internal Server Error`**: any other error:

```json
{ "error": "<message>" }
```

### Example

```bash
curl 'http://localhost:18790/api/schedules/clawboo-routine:<routine-id>/runs?limit=5'
```

---

## `GET /api/schedules/occurrences`

The upcoming runs of Clawboo's own Routines, counted per time window you name. The board's calendar sends the viewer's local midnights, so each window is one day; that keeps a 23- or 25-hour day around a clock change correct. The count is worked out on the server because the scheduler reads cron in the server's time zone, so these are the times it will actually run.

Only runs after now are counted, and only for Routines that will run. These are left out:

- a paused Routine, one stopped in `error` after a failed run, and a spent one-shot (`idle` with no next run);
- a Routine whose cron spec cannot be read;
- a team routine whose team is gone, archived, opted out of server orchestration, or has no active member;
- an agent routine whose agent is gone, archived, or a person;
- every OpenClaw Gateway cron job (those are an OpenClaw agent's own work, not team work).

For an `idle` Routine, the first run is its stored `nextRunAt`, the time the scheduler will actually use, and the cron spec gives the runs after it. A result is reused for up to a minute, and never past its first run, so boards that poll this cost little.

- **Query params**:
  - `bounds` (required): 2 to 64 comma-separated epoch-millisecond integers in strictly ascending order, spanning at most 62 days. Window `i` is `[bounds[i], bounds[i + 1])`.
  - `teamId` (optional): only Routines whose `teamId` matches. A Routine for an agent on no team appears only without this filter.
- **Request body**: none.

### Responses

**`200 OK`**: only Routines with at least one run in some window are listed, each with one entry per window, in window order:

```ts
{
  now: number // the time the count started from
  timeZone: string | null // the IANA time zone the scheduler reads cron in
  routines: Array<{
    schedule: ScheduleRecord // with teamName and agentName filled in, as on GET /api/schedules
    windows: Array<{
      count: number // runs in the window, counted up to 96
      more: boolean // true when the window holds more runs than `count`
      times: number[] // the window's first runs, ascending, at most 8
    }>
  }>
}
```

Counting stops at 96 (every fifteen minutes for a whole day), so a very frequent Routine costs a bounded amount of work; `more` says the window holds more than that. `timeZone` lets a caller in another time zone tell which zone a Routine's cron spec is read in.

**`400 Bad Request`**: `bounds` is missing, has fewer than 2 or more than 64 values, is not strictly ascending integers, or spans more than 62 days:

```json
{
  "error": "bounds must be 2 to 64 ascending epoch-ms integers spanning at most 62 days",
  "code": "invalid_bounds"
}
```

**`500 Internal Server Error`**: the Routines could not be read:

```json
{ "error": "<message>" }
```

### Example

```bash
# Three local days starting at a midnight
curl 'http://localhost:18790/api/schedules/occurrences?bounds=1791777600000,1791864000000,1791950400000,1792036800000'
```

---

## Error envelope

Every error here is `{ "error": string, "code"?: string }`. Branch on `code`, never on the message:

| `code`                        | Status | Meaning                                                                                   |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `invalid_body`                | 400    | The body failed the shape check, the cron spec does not parse, or the template is invalid |
| `bound_recurring_schedule`    | 400    | A recurring spec was bound to an existing board task (one-shot specs only)                |
| `invalid_routine_target`      | 400    | A Routine's team or agent is missing, archived, or does not match                         |
| `invalid_bounds`              | 400    | The occurrence windows are missing, out of order, too many, or too wide                   |
| `unsupported_schedule_write`  | 403    | The source is read-only (`observe-only`) for that action                                  |
| `unknown_schedule`            | 404    | The composite id matched no source or no Routine, or a bound task does not exist          |
| `duplicate_firing_owner`      | 409    | The bound board task is already scheduled by another engine; do not retry                 |
| `illegal_schedule_transition` | 409    | The pause, resume or run is not allowed from the current status                           |
| `team_task_domain_violation`  | 422    | A `team-task` create was aimed at the Gateway cron                                        |
| `schedule_source_unavailable` | 503    | A write hit the Gateway cron while Clawboo's Gateway connection is down                   |
| _(none)_                      | 500    | Any other error                                                                           |

A cron spec that does not parse answers `code: "invalid_body"` with a message that starts `Invalid cron spec`. A rate-limited request answers **429** `{ "error": "Too many requests. Wait a moment and retry." }` with a `Retry-After` header.

**Source of truth:** `apps/web/server/api/schedules.ts`; the two sources in `apps/web/server/lib/scheduleSource/`; error classes in `packages/scheduler/src/errors.ts`; Routine states in `packages/db/src/routines/state-machine.ts`.

## Related

- [Routines](/using/routines): create and manage Routines in the dashboard.
- [Scheduling](/concepts/scheduling): how Routines and OpenClaw cron jobs differ, and how a run reaches a team.
- [The board](/concepts/the-board): bound tasks and the one-claim rule.
- [System API](/reference/rest-api/system): the OpenClaw Gateway the cron source talks to.
- [@clawboo/scheduler](/reference/packages/scheduler): the shared record type, sources and errors.
- [REST API overview](/reference/rest-api/index): authentication, rate limits and conventions.
