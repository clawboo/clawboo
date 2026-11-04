---
title: 'Observability API'
sidebarTitle: 'Observability'
description: 'REST reference for the event log: the feed, traces, errors, agent health, the task graph, a live stream, and the eval smoke run.'
keywords: ['observability', 'events', 'traces', 'event log', 'sse', 'fleet health', 'evals']
---

These routes read the server's event log, the durable record of what happened on the board and in runs: tasks created and claimed, status changes, runs, tool calls, costs, approvals and errors. They return the raw feed, one trace with its totals, the error feed, each agent's health, the task-delegation graph, and a live stream. They only read: every event is written by the server itself, and no route adds events from outside. `POST /api/eval/smoke` runs the built-in eval suite. The fleet summary (`GET /api/fleet/summary`) is on the [Costs API](/reference/rest-api/costs) page.

Observability is always on: there is no switch, and every route here answers. A trace is all events that share a `traceId`; the graph, metrics, error list and agent health are all worked out from the same rows. Every route is on the general rate tier (see [rate limits](/reference/rest-api/index#rate-limits)).

<Info>

Every response that carries event payloads masks credential-shaped keys and values in the event's `data` with `••••` before sending it, on top of the secret scrub applied when the event was written. Numbers such as token counts and cost are kept. `GET /api/obs/stream` is a Server-Sent Events stream, documented below with its frames rather than a JSON body.

</Info>

## Routes

| Method | Path                       | Summary                                                  | Stream? |
| ------ | -------------------------- | -------------------------------------------------------- | ------- |
| GET    | `/api/obs/events`          | Query the orchestration event feed                       | No      |
| GET    | `/api/obs/traces/:traceId` | One reconstructed trace + aggregate metrics              | No      |
| GET    | `/api/obs/errors`          | The error feed (filter to likely Clawboo bugs)           | No      |
| GET    | `/api/obs/health`          | Each agent's state: working, idle, stalled or zombie     | No      |
| GET    | `/api/obs/graph`           | The task and delegation graph, built from the log        | No      |
| GET    | `/api/obs/stream`          | SSE live-tail of the log, scoped by team/task/agent/kind | SSE     |
| POST   | `/api/eval/smoke`          | Run the built-in eval smoke suite (no model calls)       | No      |

---

## `GET /api/obs/events`

Returns events from the log that match the query, ordered by `seq`, a number that only ever grows. The default order is `asc` (oldest first, the order things happened); pass `order=desc` for newest first.

- **Path params**: none.
- **Query params**:

| Param      | Type            | Notes                                                            |
| ---------- | --------------- | ---------------------------------------------------------------- |
| `teamId`   | string          | Match events for one team.                                       |
| `taskId`   | string          | Match events for one board task.                                 |
| `agentId`  | string          | Match events for one agent (the per-agent activity scope).       |
| `traceId`  | string          | Match events sharing a trace.                                    |
| `kinds`    | string          | Comma-separated list of event kinds; empty/blank values dropped. |
| `since`    | number          | Only events with `ts` at or after this time (epoch ms).          |
| `afterSeq` | number          | Only events with a larger `seq` (a resume cursor).               |
| `limit`    | number          | Row cap, clamped to 1-5000 (defaults to 500 when omitted).       |
| `order`    | `asc` \| `desc` | `desc` only when literally `"desc"`; anything else is `asc`.     |

- **Request body**: none.

### Responses

**`200 OK`**: the matched events. Each row is the full stored shape with its `data` field redacted (still a JSON string after masking):

```ts
{
  events: Array<{
    seq: number
    id: string
    ts: number
    kind: OrchestrationEventKind
    teamId: string | null
    taskId: string | null
    agentId: string | null
    runtime: string | null
    traceId: string | null
    spanId: string | null
    parentSpanId: string | null
    correlationId: string | null
    data: string // JSON string, credential keys/values masked with ••••
    tenantId: string | null
    createdAt: number
  }>
}
```

`OrchestrationEventKind` is one of 25 kinds: `task_created`, `task_claimed`, `status_changed`, `comment_added`, `dep_linked`, `execution_started`, `execution_completed`, `tool_call`, `tool_result`, `cost`, `approval_requested`, `approval_resolved`, `error`, `span_start`, `span_end`, `session_rotated`, `routine_fired`, `routine_dispatched`, `routine_completed`, `routine_error`, `team_chat_post`, `speaker_selected`, `turn_bound_hit`, `grant_decision`, `connector_health`. See [Events and errors](/reference/events-and-errors) for each kind's `data`.

**`500 Internal Server Error`**: any read failure:

```json
{ "error": "<message>" }
```

### Example

```bash
# Last 100 cost + error events for a team, recent first
curl "http://localhost:18790/api/obs/events?teamId=<team-uuid>&kinds=cost,error&order=desc&limit=100"
```

---

## `GET /api/obs/traces/:traceId`

Returns one trace: every event that shares the `traceId`, oldest first. A whole multi-agent task (the lead, the agents it delegated to, their tool calls) reads from this. The totals in `metrics` are worked out before each event's `data` is masked, so cost and token figures are exact.

- **Path params**: `traceId` (string).
- **Request body**: none.

### Responses

**`200 OK`**: the trace events plus the aggregate metrics:

```ts
{
  traceId: string
  events: Array<{/* same redacted row shape as GET /api/obs/events */}>
  metrics: {
    totalCostUsd: number
    inputTokens: number
    outputTokens: number
    toolErrorRate: number // failed tool results / total tool results (0 when none)
    toolCalls: number
    toolErrors: number
    eventCounts: Partial<Record<OrchestrationEventKind, number>>
    activeAgents: number
    tokensPerMinute: number // output tokens/min over the window (0 when window < 1s)
  }
}
```

The trace read is capped at 5000 events. An unknown `traceId` returns `200` with an empty `events` array and zeroed `metrics`.

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/obs/traces/<trace-id>
```

---

## `GET /api/obs/errors`

The error feed: `error` events, newest first, in a compact shape. Each error carries the class Clawboo sorted it into; an error it could not sort (class `Unknown`) is flagged `harnessBug: true`, a likely bug in Clawboo itself. Pass `harnessBug=true` to see only those.

- **Path params**: none.
- **Query params**:

| Param        | Type   | Notes                                                                           |
| ------------ | ------ | ------------------------------------------------------------------------------- |
| `harnessBug` | string | `"true"` returns only errors flagged `harnessBug`; any other value returns all. |
| `since`      | number | Only errors with `ts` at or after this time (epoch ms).                         |

- **Request body**: none.

The route always reads the 500 newest `error` events by `ts`, then applies the `harnessBug` filter. Older errors are not reachable here; use `GET /api/obs/events?kinds=error` with `afterSeq` to page through them.

### Responses

**`200 OK`**: the errors and the count of flagged ones. The whole response is masked before it is sent:

```ts
{
  errors: Array<{
    seq: number
    ts: number
    taskId: string | null
    agentId: string | null
    runtime: string | null
    errorClass: string // from event data; defaults to 'Unknown'
    harnessBug: boolean // from event data
    message: string // from event data; defaults to ''
  }>
  harnessBugCount: number // flagged errors among the 500 read, before the filter
}
```

`harnessBugCount` ignores the `harnessBug` filter, so a client can show the count while listing every error.

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
# Errors flagged as likely Clawboo bugs in the last hour
curl "http://localhost:18790/api/obs/errors?harnessBug=true&since=$(($(date +%s%3N) - 3600000))"
```

---

## `GET /api/obs/health`

Each agent's current state, worked out from the event log against the current time. An agent with an open run is `working` while events keep arriving, `stalled` after 5 quiet minutes and `zombie` after 30 (its process has almost certainly died; the server's stale-run cleanup closes such runs). An agent with no open run is `idle`.

- **Path params**: none.
- **Query params**: `teamId` (string), scope to one team.
- **Request body**: none.

Only the **most recent 5000 events** in scope are read. The event log only grows (nothing prunes it), so this works from a recent window, not the whole history: an agent whose activity has scrolled out of the window stops appearing.

### Responses

**`200 OK`**: one entry per agent that appears in the window:

```ts
{
  agents: Array<{
    agentId: string
    status: 'working' | 'idle' | 'stalled' | 'zombie'
    lastEventTs: number
    activeTaskId: string | null
    openExecutions: number
    costUsd: number
  }>
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl "http://localhost:18790/api/obs/health?teamId=<team-uuid>"
```

---

## `GET /api/obs/graph`

Builds the task graph from the event log: tasks with their status and cost, the delegation and dependency edges between them, and the agent-to-agent delegations they imply. The same events always give the same graph.

- **Path params**: none.
- **Query params**: `teamId` (string), scope to one team.
- **Request body**: none.

Only the **most recent 5000 events** in scope are read, as for health. A task whose events have all left that window stops appearing, and a task partly inside it is drawn from the events that remain.

### Responses

**`200 OK`**: the graph. It carries no raw event `data`, so nothing in it is masked:

```ts
{
  tasks: Array<{
    id: string
    title: string | null
    status: string
    assigneeAgentId: string | null
    parentTaskId: string | null
    runtime: string | null
    teamId: string | null
    costUsd: number
  }>
  taskEdges: Array<{
    id: string
    source: string
    target: string
    kind: 'delegation' | 'dependency'
  }>
  agents: Array<{
    id: string
    costUsd: number
    taskIds: string[]
  }>
  agentEdges: Array<{
    id: string
    source: string
    target: string
    kind: 'delegation' | 'dependency' // edges between agents are always 'delegation'
  }>
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl "http://localhost:18790/api/obs/graph?teamId=<team-uuid>"
```

---

## `GET /api/obs/stream`

A Server-Sent Events tail of the event log, optionally scoped to a team, task or agent and narrowed to a list of event kinds. The route polls the log every 750 ms past a `seq` cursor and sends any new events. It reads the database, so it also sees events that another process writes to the same database file. Resume with the `EventSource` `Last-Event-ID` header, `?afterSeq=<seq>` or `?since=<seq>`.

**Where it starts.** With no cursor, the cursor is `0`: the stream first replays the whole log for its scope, 500 events per poll, and only then follows new events. This is the opposite of the chat streams, which start at the newest message. To watch only new events, pass the newest `seq` as `afterSeq` (read it with `GET /api/obs/events?order=desc&limit=1`).

- **Path params**: none.
- **Query params**:

| Param      | Type   | Notes                                                                                                 |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `teamId`   | string | Scope the tail to one team.                                                                           |
| `taskId`   | string | Scope the tail to one board task.                                                                     |
| `agentId`  | string | Scope the tail to one agent.                                                                          |
| `kinds`    | string | Comma-separated list of event kinds; empty/blank values dropped. Only events of these kinds are sent. |
| `afterSeq` | number | Resume after this `seq`, the same cursor as on `GET /api/obs/events`.                                 |
| `since`    | number | The same as `afterSeq`. Here it is a `seq`, not the time it means on `GET /api/obs/events`.           |

The cursor is the first of `Last-Event-ID`, `afterSeq` and `since` that holds a number of `0` or more. A missing, malformed or negative value is skipped, and with none left the cursor is `0`. A browser's `EventSource` reconnects to the same URL with the last `id` it received as `Last-Event-ID`, so that header wins over the query.

- **Request body**: none.

<Note>

This is an SSE route: there is no JSON response body, and the catalog below describes the frames. Each poll reads up to 500 matching events past the cursor, oldest first. The cursor only moves forward, so resuming from an old cursor replays everything in scope after it.

</Note>

### Connection

On open, the handler writes `HTTP/1.1 200` with:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

then emits a `: connected` comment frame and flushes any rows already past the cursor.

### Event catalog

| Frame         | When                                         | Shape                                                                              |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `: connected` | Immediately on open                          | SSE comment (ignored by `EventSource`)                                             |
| event data    | Per new log row in scope (poll every 750 ms) | `id: <seq>` line + `data: <json>` line (the full event row, `data` field redacted) |
| `: keepalive` | Every 20 s while open                        | SSE comment (keeps the connection warm)                                            |

The `data:` payload is one stored event row, identical in shape to a `GET /api/obs/events` row, with its inner JSON `data` field masked (`••••`). The `id:` value is the row's `seq`; the browser sends it back as `Last-Event-ID` on auto-reconnect, so the tail resumes without gaps.

Example frames:

```text
: connected

id: 4187
data: {"seq":4187,"id":"...","ts":1718450000000,"kind":"tool_call","taskId":"...","agentId":"...","runtime":"claude-code","traceId":"...","data":"{\"toolName\":\"read_file\"}","tenantId":null,"createdAt":1718450000000}

: keepalive
```

### Example

```bash
curl -N "http://localhost:18790/api/obs/stream?taskId=<task-uuid>"

# Resume from a known seq
curl -N "http://localhost:18790/api/obs/stream?taskId=<task-uuid>&afterSeq=4187"

# Only approval requests and answers, for every team
curl -N "http://localhost:18790/api/obs/stream?kinds=approval_requested,approval_resolved"
```

### Following approvals

A client that shows or forwards approval cards, such as a notifier or a mirror, can follow them on this stream instead of polling `GET /api/tools/approvals`:

1. Read the newest `seq` with `GET /api/obs/events?order=desc&limit=1` (`0` when the log is empty).
2. Read the open cards with [`GET /api/tools/approvals`](/reference/rest-api/tools-and-mcp).
3. Open `GET /api/obs/stream?kinds=approval_requested,approval_resolved&afterSeq=<seq>`, with no team, task or agent scope.

A card opened between steps 1 and 2 arrives in both the list and the stream, so match cards by `approvalId`, the row's `id` in the list. Each frame carries the agent, its team and the task (when known) on the row, and the approval id, kind and tool name in `data`. It never carries the call's arguments, its reason or the command text. See [Approval events](/reference/events-and-errors#approval-events) for both shapes.

```text
id: 5120
data: {"seq":5120,"id":"...","ts":1718450000000,"kind":"approval_requested","teamId":"...","taskId":"...","agentId":"...","runtime":null,"traceId":null,"spanId":null,"parentSpanId":null,"correlationId":null,"data":"{\"approvalId\":\"...\",\"kind\":\"tool\",\"toolName\":\"files_delete\",\"toolClass\":\"destructive\",\"grantId\":null,\"connectorId\":null,\"expiresAt\":1718450300000}","tenantId":null,"createdAt":1718450000000}
```

A card stops being answerable at its `expiresAt`. See [`approval_resolved`](/reference/events-and-errors#approval_resolved) for when an unanswered card's event arrives.

---

## `POST /api/eval/smoke`

Runs the smoke subset of Clawboo's built-in eval suite (`SMOKE_TASKS`) and returns its report. It calls no model, needs no provider key, starts no runtime and uses no network. Each trial runs on its own throwaway board in a temporary SQLite file, never your `clawboo.db`, and the temporary files are removed afterwards. The ablation self-test runs only in the repository's manual `evals.yml` workflow, never from this route.

- **Path/query params**: none.
- **Request body**:

```ts
{
  trials?: number  // 1 to 3; missing or not a number means 1
  k?: number       // 1 to 3; missing or not a number means the trials value
}
```

Both values are rounded down and kept between 1 and 3, so the run stays small.

### Responses

**`200 OK`**: the suite report:

```ts
{
  tasks: Array<{
    taskId: string
    suite: 'capability' | 'regression'
    kind: 'coding' | 'research' | 'coordination'
    trials: Array<{
      taskId: string
      passed: boolean
      score: number
      graders: Array<{/* GraderResult */}>
    }>
    passAt1: number // per-trial success rate = empirical pass@1
    passPowK: number // probability all k trials pass = passAt1^k
    meanScore: number // mean partial-credit score across trials
  }>
  passAt1: number // macro-averaged pass@1 across tasks
  passPowK: number // macro-averaged pass^k across tasks
  k: number
}
```

**`500 Internal Server Error`**: the run failed (the temporary files are still removed):

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/eval/smoke \
  -H 'Content-Type: application/json' \
  -d '{"trials":3,"k":2}'
```

---

## Error envelope

Most error bodies are `{ "error": "<message>" }`; on the `/api/obs/*` routes the message is masked before it is sent. `POST /api/eval/smoke` answers the bare suite report rather than an object around it.

## Related

- [Observability](/concepts/observability): the event log, traces and agent health.
- [Observability panel](/using/observability): the dashboard views over these routes.
- [Events and errors](/reference/events-and-errors): each event kind's `data` and the error classes.
- [Costs API](/reference/rest-api/costs): cost records and the fleet summary.
- [Board API](/reference/rest-api/board): the board routes that write task events.
