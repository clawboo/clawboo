---
title: 'Events and errors reference'
sidebarTitle: 'Events and errors'
description: 'The 25 orchestration event kinds and their data, the classes Clawboo sorts failures into, the codes in the log, and where each one appears.'
keywords:
  [
    'event log',
    'orchestration events',
    'error taxonomy',
    'harness bug',
    'PolicyDenied',
    'grant_decision',
    'connector_health',
    'traces',
    'fleet health',
  ]
---

Clawboo records what its agents do in an append-only event log inside its SQLite database (the `orchestration_events` table). The **Observability** and **Fleet** panels and the **Activity** feeds on tasks, agents and teams all read it. This page lists every event kind with its data, the classes Clawboo sorts failures into, and the codes you may find in the log.

These are the orchestration events defined in `@clawboo/obs`. The OpenClaw Gateway's own events, which the dashboard handles in the browser, are a separate stream (see [Event pipeline](/internals/event-pipeline)).

## Event kinds

There are 25 kinds. New kinds are only ever added, so older logs keep parsing.

| Kind                                          | Group      | Records                                                        | Written by                                                  | Activity badge     |
| --------------------------------------------- | ---------- | -------------------------------------------------------------- | ----------------------------------------------------------- | ------------------ |
| [`task_created`](#task_created)               | Board      | A task was created                                             | Board API, team engine                                      | task               |
| [`task_claimed`](#task_claimed)               | Board      | An agent was given a task                                      | Board API, team engine                                      | claim              |
| [`status_changed`](#status_changed)           | Board      | A task moved to another status                                 | Board API, team engine                                      | status             |
| [`comment_added`](#comment_added)             | Board      | A comment landed on a task                                     | Board API, team engine                                      | note               |
| [`dep_linked`](#dep_linked)                   | Board      | A task was made to wait for another                            | Board API, team engine                                      | (hidden)           |
| [`execution_started`](#execution_started)     | Runs       | A run of a task started                                        | Task runner, team engine, board API, OpenClaw routine fires | run                |
| [`execution_completed`](#execution_completed) | Runs       | A run finished                                                 | Task runner, team engine, board API, OpenClaw routine fires | run                |
| [`tool_call`](#tool_call)                     | Runs       | An agent called a tool                                         | Task runner, team engine, OpenClaw session watcher          | tool               |
| [`tool_result`](#tool_result)                 | Runs       | A tool returned                                                | Task runner, team engine, OpenClaw session watcher          | result             |
| [`cost`](#cost)                               | Runs       | Spend and tokens reported during a run                         | Task runner, OpenClaw routine fires                         | cost               |
| [`session_rotated`](#session_rotated)         | Runs       | A run moved to a fresh session                                 | Task runner                                                 | session rotated    |
| [`approval_requested`](#approval_requested)   | Approvals  | Declared; nothing writes it                                    | None                                                        | approval           |
| [`approval_resolved`](#approval_resolved)     | Approvals  | An abandoned approval expired                                  | Approval reaper                                             | approval           |
| [`error`](#error)                             | Errors     | A failure, sorted into an [error class](#error-classes)        | Task runner, team engine                                    | error              |
| [`span_start`](#span_start)                   | Traces     | A task-runner run span opened                                  | Task runner                                                 | (hidden)           |
| [`span_end`](#span_end)                       | Traces     | A run span closed                                              | Task runner                                                 | (hidden)           |
| [`routine_fired`](#routine_fired)             | Routines   | A due routine was picked up                                    | Routines engine                                             | routine fired      |
| [`routine_dispatched`](#routine_dispatched)   | Routines   | A routine's work was handed to its target                      | Routines engine                                             | routine dispatched |
| [`routine_completed`](#routine_completed)     | Routines   | A routine fire succeeded and the routine re-armed              | Routines engine                                             | routine completed  |
| [`routine_error`](#routine_error)             | Routines   | A routine fire failed                                          | Routines engine                                             | routine error      |
| [`team_chat_post`](#team_chat_post)           | Peer room  | An agent posted through the TeamChat MCP server                | TeamChat MCP over HTTP                                      | team chat post     |
| [`speaker_selected`](#speaker_selected)       | Peer room  | The agents' exchange picked the next speaker                   | Team exchange API                                           | speaker selected   |
| [`turn_bound_hit`](#turn_bound_hit)           | Peer room  | An agents' exchange ended                                      | Team exchange API                                           | turn bound hit     |
| [`grant_decision`](#grant_decision)           | Connectors | A grant check allowed, paused or refused a connector tool call | Tool broker                                                 | grant              |
| [`connector_health`](#connector_health)       | Connectors | A connector's health changed                                   | Connector supervisor                                        | connector          |

- **Board API** means the board routes the dashboard calls. Board changes made through the [Tasks MCP tools](/reference/mcp-tools) or by the task runner itself update the live board views but are not written to the log as board events.
- **Task runner** runs serve `POST /api/runtimes/:id/run` and agent routine fires on runtimes other than OpenClaw. **Team engine** runs serve team chat and the tasks it delegates. See [How a team works](/intro/how-it-works) for the two paths.
- **Peer room** events concern the agents' peer room behind the [TeamChat server](/reference/mcp-tools#teamchat-server), not the team chat you use in the dashboard.
- A runtime mirror can also push `tool_call`, `tool_result`, `error`, `grant_decision` and `connector_health` through `POST /api/obs/ingest` (see [Writing events from outside](#writing-events-from-outside)).

## Error classes

Every failure an `error` event records is sorted into one class by matching its code and message. Anything that matches no class is `Unknown`, which Clawboo treats as a **harness bug**: a failure its run machinery could not explain, worth a look rather than routine noise.

| Class             | Meaning                                   | Matches, for example (case-insensitive)                                                                                   | Harness bug |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `RateLimited`     | The provider throttled the request        | `429`, `rate limit`, `too many requests`, `resource exhausted`, `quota`                                                   | No          |
| `UserAborted`     | A person or Clawboo stopped the run       | `abort`, `aborted`, `cancel`, `cancelled`, `sigint`, `sigterm`                                                            | No          |
| `Timeout`         | Something took too long                   | `timeout`, `timed out`, `etimedout`, `deadline exceeded`                                                                  | No          |
| `UnexpectedEnv`   | The machine was missing something         | `enoent`, `eacces`, `eperm`, `command not found`, `permission denied`, `not installed`, `cannot find module`              | No          |
| `ContextOverflow` | The prompt was too long for the model     | `context length`, `context window`, `prompt is too long`, `maximum context`, `too many tokens`                            | No          |
| `InvalidArgs`     | The request was malformed                 | `400`, `422`, `invalid argument`, `bad request`, `validation`, `missing required`, `schema`, `malformed`                  | No          |
| `ProviderError`   | The provider failed                       | `500`, `502`, `503`, `504`, `provider error`, `upstream`, `overloaded`, `service unavailable`, `bad gateway`, `api error` | No          |
| `Unknown`         | Nothing matched, or the error had no text | Anything else                                                                                                             | Yes         |
| `PolicyDenied`    | A guardrail refused a call (expected)     | Task-runner runs only; see [PolicyDenied](#policydenied)                                                                  | No          |

### PolicyDenied

In a task-runner run, an `error` whose code is `policy_denied`, `permission_denied`, `denied`, `forbidden`, `unauthorized`, `eperm` or `eacces` (in any case) is recorded with `errorClass: 'PolicyDenied'` and `harnessBug: false`. That is how a Clawboo Native agent's refused tool call (a broker denial, or a [Tasks creation cap](/reference/mcp-tools#creation-caps)) is logged. Two such denials in a row in one run trip the circuit breaker (`repeat-policy-denied`).

The team engine does not have this rule: it runs every error through the classifier. A tool denial in team chat therefore gets whichever class its message matches, often `Unknown`, and is then counted as a harness bug.

### Where errors show up

| Place                                                       | What you see                                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settings > Insights > Observability**, **Error taxonomy** | Recent errors grouped by class with a count each; an `Unknown` row carries a **harness bug** label. "No errors" means none in the latest 500 |
| **Observability** trace timeline                            | Each error as `[<class>] <message>`                                                                                                          |
| **Settings > Insights > Fleet**, **Recent issues**          | Class, runtime and message per error; "All clear" when there are none                                                                        |
| A runtime's diagnostics drawer in **Runtimes**              | **Recent errors** with class and message                                                                                                     |
| **Activity** on a task, agent or team                       | An **error** badge with the message                                                                                                          |

The error lists read the latest 500 `error` events, and the harness-bug count covers those 500 only.

<Tip>

A harness bug is not something your agent did wrong. It usually means a runtime returned an error message Clawboo does not recognize. If one keeps appearing, note the message (task-runner runs also write an error-level server log line with `"action": "harness_bug"`) and [open an issue](https://github.com/clawboo/clawboo/issues).

</Tip>

## The event envelope

Every event has the same envelope, whatever its kind:

```ts
{
  id: string // a UUID
  seq?: number // assigned by SQLite when the row is written
  ts: number // when the event happened, epoch milliseconds
  kind: OrchestrationEventKind // one of the 25 kinds
  teamId?: string | null
  taskId?: string | null
  agentId?: string | null
  runtime?: string | null
  traceId?: string | null
  spanId?: string | null
  parentSpanId?: string | null
  correlationId?: string | null
  tenantId?: string | null
  data: Record<string, unknown> // kind-specific; defaults to {}
}
```

| Field                                    | Meaning                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `seq`                                    | Increases with every row and is never reused, across every process writing the file. Order the log by `seq`.                        |
| `ts`                                     | When the writer says the event happened. The table also stores `created_at`, the insert time.                                       |
| `teamId`, `taskId`, `agentId`, `runtime` | What the event concerns. Any of them can be null.                                                                                   |
| `traceId`, `spanId`, `parentSpanId`      | Only on task-runner runs. Every run under one root task shares a trace, whose `traceId` is that root task's id; each run is a span. |
| `correlationId`                          | An optional grouping key; most events leave it empty.                                                                               |
| `tenantId`                               | Unused; always null.                                                                                                                |
| `data`                                   | The kind's payload, described below. It is an open object: readers must tolerate missing or extra fields.                           |

That is 13 fields plus `data`. Before a row is stored, secrets in `data` are scrubbed, and an unrecognized `kind` is stored as `error`. Writing an event never fails the work that produced it: a failed write is dropped. Nothing deletes rows from the log, so it grows until you reset or trim the database (see [Data and state](/operating/data-and-state)).

## Board events

Board events carry the task in `taskId` and its team in `teamId`.

### task_created

A task was created.

```ts
{ title?: string | null; status?: string; parentTaskId?: string | null; priority?: string | null }
```

### task_claimed

An agent was given a task, by a claim or an assignment.

```ts
{ assigneeAgentId?: string | null; assigneeRuntime?: string | null }
```

### status_changed

A task moved to another status. `to` is always present.

```ts
{ from?: string | null; to: string }
```

Some writers add fields the typed shape does not declare:

- `by: 'person'` marks a move a person made on the board.
- `reason` says why the server moved it: `retry` (a person pressed Retry), `assigned` (a person assigned the task), or `blocker_failed` (a task it waited on failed or was cancelled, so it was cancelled too).

### comment_added

A comment or system note landed on a task.

```ts
{ authorType?: string; body?: string }
```

### dep_linked

A task was made to wait for another. The task that waits is `taskId`.

```ts
{
  dependsOnTaskId: string
}
```

## Run events

### execution_started

A run of a task started. `execId` is the row in the `execution_processes` table.

```ts
{ execId: string; executorType?: string; runReason?: string | null }
```

### execution_completed

A run finished. The cost and token fields carry the run's final totals (see [Cost totals](#cost-totals)).

```ts
{
  execId: string
  status: string // the run's final status, such as 'succeeded', 'failed' or 'cancelled'
  costUsd?: number | null
  inputTokens?: number
  outputTokens?: number
  error?: string | null
}
```

On task-runner runs, `error` holds a code when Clawboo stopped or refused the run:

| `error`                   | `status`                | Meaning                                                                                                              |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `workspace_unavailable`   | `failed`                | A file-changing task had no repository, or its git worktree could not be created, so the run was refused             |
| `budget_paused:<scope>`   | `cancelled`             | A hard-cap budget stopped the run; `<scope>` is `agent`, `mission`, `team`, or `node` (a routine's per-run cost cap) |
| `circuit_broken:<reason>` | `cancelled`             | A circuit breaker stopped the run; see the reasons below                                                             |
| Anything else             | `failed` or `cancelled` | The run's own error summary                                                                                          |

Breaker reasons, also posted on the task as a comment that begins `[stopped: <reason>]`:

| Reason                 | Trips when                                                |
| ---------------------- | --------------------------------------------------------- |
| `iteration-cap`        | The run made too many tool calls                          |
| `repeat-failure`       | The same tool call failed several times in a row          |
| `no-progress`          | Tool calls kept failing without any new successful result |
| `token-velocity`       | Tokens per minute (input plus output) passed the ceiling  |
| `repeat-policy-denied` | Guardrails refused the run's calls twice in a row         |

Budgets and breakers are explained in [Governance](/concepts/governance); their defaults are in [Limits and defaults](/reference/limits-and-defaults).

### tool_call

An agent called a tool. `toolCallId` matches the call's `tool_result`. Secrets in `input` are scrubbed.

```ts
{ toolCallId: string; name: string; input?: unknown; grantId?: string | null; connectorId?: string | null }
```

`grantId` and `connectorId` are declared for attribution, but Clawboo's own writers leave them out. Grant attribution for connector calls is in [`grant_decision`](#grant_decision) events and the tool audit.

### tool_result

A tool returned. `isError` feeds the tool error rate in the trace metrics.

```ts
{ toolCallId: string; name: string; isError: boolean; output?: string }
```

### cost

Spend and tokens reported during a run. Several can arrive for one run; see [Cost totals](#cost-totals).

```ts
{
  costUsd?: number | null
  inputTokens?: number
  outputTokens?: number
  model?: string | null
  estimated?: boolean // task-runner runs: Clawboo priced the figure itself
  local?: true // task-runner runs: a model the user's own Ollama served, recorded at $0
}
```

Team chat runs write no `cost` events; their spend is charged to budgets directly. See [Budgets and spend](/using/budgets-and-spend) for which runtimes report real cost and which are estimated.

### session_rotated

A task-runner run reached its turn limit or filled its context, and continued in a fresh session. The new session starts from a short handoff note, not the old transcript.

```ts
{
  from: string // the previous session's key
  to: string // the new session's key
  reason: 'max_turns' | 'context_watermark'
  tokensUsed?: number // tokens the previous session used
  rotationIndex?: number // 1 for the first rotation in the task's run chain
}
```

## Approval events

### approval_requested

Declared, but nothing writes it. Pending tool approvals live in the `tool_call_approvals` table and appear under **Needs you** on the Board (see [Approvals](/using/approvals)).

```ts
{ approvalId?: string; scopeKey?: string; kind?: string }
```

### approval_resolved

Written only when the approval reaper expires an approval nobody answered. The reaper runs hourly and expires pending approvals older than 24 hours (`CLAWBOO_APPROVAL_TTL_MS`). A person's decision is stored on the approval row itself, not as an event.

```ts
{ approvalId?: string; decision?: string } // decision is 'expired'
```

## Error events

### error

A failure during a run, with its [error class](#error-classes).

```ts
{
  code?: string | null
  message: string
  errorClass: string // an error class, or 'PolicyDenied'
  harnessBug: boolean // true when errorClass is 'Unknown'
  fatal?: boolean
}
```

- The task runner writes one for each error a runtime reports, and one more (with `code: null` and `fatal: true`) when a run ends in an error.
- The team engine writes one for each error a runtime reports during team chat.
- Classification joins `code` and `message`, and the rules are tried in the order of the [classes table](#error-classes), first match wins. `ContextOverflow` is tried before `InvalidArgs`, so an oversized prompt that a provider rejects with a 400 counts as a context overflow.

## Trace events

### span_start

The task runner opens one span per run, named `run:<taskId>`, with `spanKind: 'task'`. A child task's run nests under its parent task's run.

```ts
{ name: string; spanKind?: 'task' | 'tool' | 'run' }
```

### span_end

The run's span closed.

```ts
{ name: string; status?: 'ok' | 'error'; durationMs?: number }
```

Team chat runs, OpenClaw routine fires and board API events carry no trace, so they never appear in the **Traces** list. When OpenTelemetry export is set up, task-runner spans also go to your collector; see [Observability](/concepts/observability).

## Routine events

Routine events carry the routine's ledger row in `data.scheduledRunId` (a `scheduled_runs` row). See [Routines](/using/routines).

### routine_fired

A due routine was picked up for firing.

```ts
{
  scheduledRunId: string
  cronSpec: string
  scheduledBy: string
} // scheduledBy is 'clawboo' for the Routines engine
```

### routine_dispatched

The fire was handed to its target.

```ts
{
  scheduledRunId: string
  taskId: string | null // null for a team routine, which creates no task
  runtime: string | null
  dispatchPath: 'one-shot' | 'connected' | 'human' | 'team-chat'
  targetAgentId?: string | null // team routines: the agent the message went to
}
```

`dispatchPath` is `one-shot` when the task runner ran it, `connected` when it went to the OpenClaw Gateway, and `team-chat` when a team routine posted its message to the team chat. The type also allows `human`, which nothing writes.

### routine_completed

The fire succeeded and the routine re-armed.

```ts
{ scheduledRunId: string; taskId?: string | null; status: string; nextRunAt?: number | null }
```

`status` is `idle`. `nextRunAt` is the next fire time, or `null` when nothing is left to fire (a spent one-time routine).

### routine_error

The fire failed. The routine stops in an error state until someone resumes it.

```ts
{ scheduledRunId: string; code?: string | null; message: string } // code is declared but not written
```

| `message`, for example                             | Meaning                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `dispatch refused: <reason>`                       | The task runner refused the run: `workspace_unavailable`, `budget_paused`, `too_deep`, `connected_substrate` or `not_found` |
| `run <reason>: <summary>`                          | The run ended without success; `<reason>` is `max_turns`, `aborted` or `error`                                              |
| `The agent "<name>" was removed.`                  | The routine's agent is archived                                                                                             |
| `agent <id> not found`                             | The routine's agent no longer exists                                                                                        |
| `The team "<name>" is archived.`                   | A team routine's team is archived                                                                                           |
| `The team this routine posts to no longer exists.` | A team routine's team was deleted                                                                                           |
| `invalid task template`                            | The stored routine could not be read                                                                                        |
| `dispatch failed`                                  | The dispatch failed without a message                                                                                       |

## Peer room events

These concern the agents' peer room (the `team_chat` table), which the dashboard does not show. See [Peer chat](/concepts/peer-chat).

### team_chat_post

A bound agent posted through the [TeamChat MCP server](/reference/mcp-tools#teamchat-server) over HTTP, so this covers Claude Code, Codex and Hermes agents. Posts that Clawboo Native agents make in-process are not logged.

```ts
{
  roomId: string
  seq: number
  authorAgentId: string
  postKind: 'peer' | 'system' | 'user'
}
```

`seq` is the post's position in its room. `authorAgentId` comes from the session's signed binding, never from tool arguments.

### speaker_selected

The agents' exchange (`POST /api/team-chat/exchange`) picked the next agent to speak.

```ts
{
  roomId: string
  speakerAgentId: string
  policy: 'leader-nominated' | 'round-robin'
  exchangeTurn: number
} // exchangeTurn starts at 1
```

### turn_bound_hit

An agents' exchange ended.

```ts
{
  roomId: string
  reason: string
  maxExchangeTurns: number
  turnsTaken: number
}
```

`reason` is `max_turns` (the turn cap was reached with replies still owed), `no_pending_obligation` (nobody owed a reply), `budget_paused` (a paused hard-cap budget refused a turn, or a turn's spend paused one) or `aborted` (the caller disconnected). The typed shape lists only the first two.

## Connector events

### grant_decision

The tool broker checked a connector tool call against the caller's grants. Builtin tools are not governed by grants and write none. It is its own kind because a refused call produces no `tool_call`.

```ts
{
  decision: string // 'allow' | 'require_approval' | 'deny'
  reason?: string | null // null when allowed
  grantId?: string | null
  connectorId?: string | null
  toolName: string
  ruleId?: string | null // set when a remembered decision ("Always") decided it
}
```

The **Activity** feed shows it as `<decision>: <reason>` under a **grant** badge. Reasons, in the order the check applies them:

| `reason`            | `decision`         | Meaning                                                                                       |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `no-grant`          | `deny`             | No grant gives this agent, its team, or every agent the connector                             |
| `grant-revoked`     | `deny`             | The grant was revoked                                                                         |
| `grant-suspended`   | `deny`             | The grant is suspended                                                                        |
| `grant-proposed`    | `deny`             | The grant was proposed but not approved                                                       |
| `grant-expired`     | `deny`             | The grant has expired                                                                         |
| `spec-drift`        | `deny`             | The connector's definition or tool list changed since the grant was made                      |
| `tool-not-in-scope` | `deny`             | The grant's tool allow and deny lists exclude this tool                                       |
| `mode-insufficient` | `deny`             | The tool needs a higher grant mode (`read`, then `write`, then `admin` for destructive tools) |
| `rate-limited`      | `deny`             | The grant's hourly call limit was reached                                                     |
| `lethal-trifecta`   | `require_approval` | The tool can read private data, take in untrusted content and send data out. Never remembered |
| `tainted-run`       | `require_approval` | Defined, but nothing marks a run tainted, so it does not occur                                |
| `standing-deny`     | `deny`             | A remembered "deny" rule matched                                                              |
| `never-remembered`  | `require_approval` | This tool always asks, even with a remembered "Always" on file                                |
| `policy-always`     | `require_approval` | The grant asks for approval on every call                                                     |
| `policy-writes`     | `require_approval` | The grant asks for approval on every call that changes something                              |
| `risk-destructive`  | `require_approval` | The tool is destructive                                                                       |
| `risk-external`     | `require_approval` | The tool acts outside Clawboo and changes something                                           |

A call the grant check allows can still ask for approval later in the broker, for example a destructive tool. See [Connectors](/using/connectors) and [Approvals](/using/approvals).

### connector_health

A connector's health changed.

```ts
{ connectorId: string; health: string; detail?: string | null; failures?: number }
```

`health` is one of `unknown`, `ok`, `needs-auth`, `degraded`, `error` or `drift`. The server writes this event with `health: 'error'` and `detail: 'the connector process exited'` when a connector's process stops. The other values can arrive through `POST /api/obs/ingest`. `drift` means the connector's tools no longer match what was approved, so review what changed before trusting it again.

## Cost totals

`cost` events add up during a run, and `execution_completed` carries the run's total. Some runtimes report cost only when the run ends. So the trace metrics and the graph take, for each run (keyed by `taskId`), the larger of the summed `cost` events and the completed total. Nothing is counted twice, and a run with no `cost` events still shows its total.

## Fleet health

The **Fleet health** list in the **Observability** panel gives each agent a status from its recent events:

| Status    | Rule                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `working` | Has an open run (an `execution_started` without its `execution_completed`) and an event in the last 5 minutes |
| `stalled` | Has an open run and no event for 5 minutes                                                                    |
| `zombie`  | Has an open run and no event for 30 minutes; its process is probably gone                                     |
| `idle`    | Has no open run                                                                                               |

The panel reads the latest 5,000 events, and a single trace returns at most 5,000 events.

## Writing events from outside

`POST /api/obs/ingest` lets a process on this machine mirror runtime events into the log. The body is `{ "events": [ ... ] }`, and each event may set `kind`, `ts`, `teamId`, `taskId`, `agentId`, `runtime` and `data`.

- Only `tool_call`, `tool_result`, `error`, `grant_decision` and `connector_health` are accepted, so board, cost, approval and routine events cannot be forged this way. Other kinds are skipped.
- At most 200 events per request are read. The answer is `{ "ok": true, "count": <stored> }`.
- A `ts` more than 60 seconds ahead of the server's clock, or more than 24 hours behind it, is replaced with the server's time. A missing `runtime` is stored as `openclaw`.
- For `grant_decision` and `connector_health`, unknown fields are dropped, text is redacted and cut to 200 characters (ids to 120), an unknown `health` becomes `unknown`, and an unknown `decision` becomes `deny`.

The route sits behind the access gate like every `/api/` route. See the [Observability API](/reference/rest-api/observability).

## Structured log lines

Alerts such as the harness-bug alert are written to the server log as structured entries in this shape, with secrets scrubbed:

```ts
{
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  component: string
  action: string
  durationMs?: number
  input?: unknown
  output?: unknown
  error?: string
  correlationId: string
  traceId?: string | null
  spanId?: string | null
  taskId?: string | null
  agentId?: string | null
  runtime?: string | null
}
```

The harness-bug alert is an `error` entry with `component: 'runtime'`, `action: 'harness_bug'`, `error: '[<class>] <message>'` and the run's execution id in `correlationId`. Only task-runner runs write it. Where the server log lives is in the [CLI reference](/reference/cli).

## Related

- [Observability](/concepts/observability): what Clawboo records and how to read it.
- [Observability API](/reference/rest-api/observability): the routes that serve the log, traces, errors and fleet health.
- [Governance](/concepts/governance): budgets, caps and circuit breakers.
- [MCP tools](/reference/mcp-tools): the tools whose calls and refusals appear here.
- [Database schema](/reference/database-schema#orchestration_events): the table that stores the log.
