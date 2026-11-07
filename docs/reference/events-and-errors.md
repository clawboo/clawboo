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
    'task_wake_skipped',
    'traces',
    'fleet health',
  ]
---

Clawboo records what its agents do in an append-only event log inside its SQLite database (the `orchestration_events` table). The **Observability** and **Fleet** panels and the **Activity** feeds on tasks, agents and teams all read it. This page lists every event kind with its data, the classes Clawboo sorts failures into, and the codes you may find in the log.

These are the orchestration events defined in `@clawboo/obs`. The OpenClaw Gateway's own events, which the dashboard handles in the browser, are a separate stream (see [Event pipeline](/internals/event-pipeline)).

## Event kinds

There are 25 kinds. New kinds are only ever added, so older logs keep parsing.

| Kind                                          | Group      | Records                                                        | Written by                                                                         | Activity badge     |
| --------------------------------------------- | ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| [`task_created`](#task_created)               | Board      | A task was created                                             | Board API, team engine                                                             | task               |
| [`task_claimed`](#task_claimed)               | Board      | An agent was given a task                                      | Board API, team engine                                                             | claim              |
| [`status_changed`](#status_changed)           | Board      | A task moved to another status                                 | Board API, team engine                                                             | status             |
| [`comment_added`](#comment_added)             | Board      | A comment landed on a task                                     | Board API, team engine                                                             | note               |
| [`dep_linked`](#dep_linked)                   | Board      | A task was made to wait for another                            | Board API, team engine                                                             | (hidden)           |
| [`execution_started`](#execution_started)     | Runs       | A run of a task started                                        | Task runner, team engine, board API, OpenClaw routine fires                        | run                |
| [`execution_completed`](#execution_completed) | Runs       | A run finished                                                 | Task runner, team engine, board API, OpenClaw routine fires                        | run                |
| [`tool_call`](#tool_call)                     | Runs       | An agent called a tool                                         | Task runner, team engine, OpenClaw session watcher                                 | tool               |
| [`tool_result`](#tool_result)                 | Runs       | A tool returned                                                | Task runner, team engine, OpenClaw session watcher                                 | result             |
| [`cost`](#cost)                               | Runs       | Spend and tokens reported during a run                         | Task runner, OpenClaw routine fires                                                | cost               |
| [`session_rotated`](#session_rotated)         | Runs       | A run moved to a fresh session                                 | Task runner                                                                        | session rotated    |
| [`approval_requested`](#approval_requested)   | Approvals  | An approval card opened                                        | Tool broker, Clawboo Native commands, risky hand-offs, OpenClaw command mirror     | approval           |
| [`approval_resolved`](#approval_resolved)     | Approvals  | An approval card was answered or expired                       | Approval routes, the same writers as `approval_requested`, and the approval reaper | approval           |
| [`error`](#error)                             | Errors     | A failure, sorted into an [error class](#error-classes)        | Task runner, team engine                                                           | error              |
| [`span_start`](#span_start)                   | Traces     | A task-runner run span opened                                  | Task runner                                                                        | (hidden)           |
| [`span_end`](#span_end)                       | Traces     | A run span closed                                              | Task runner                                                                        | (hidden)           |
| [`routine_fired`](#routine_fired)             | Routines   | A due routine was picked up                                    | Routines engine                                                                    | routine fired      |
| [`routine_dispatched`](#routine_dispatched)   | Routines   | A routine's work was handed to its target                      | Routines engine                                                                    | routine dispatched |
| [`routine_completed`](#routine_completed)     | Routines   | A routine fire succeeded and the routine re-armed              | Routines engine                                                                    | routine completed  |
| [`routine_error`](#routine_error)             | Routines   | A routine fire failed                                          | Routines engine                                                                    | routine error      |
| [`team_chat_post`](#team_chat_post)           | Peer room  | An agent posted through the TeamChat MCP server                | TeamChat MCP over HTTP                                                             | team chat post     |
| [`speaker_selected`](#speaker_selected)       | Peer room  | The agents' exchange picked the next speaker                   | Team exchange API                                                                  | speaker selected   |
| [`turn_bound_hit`](#turn_bound_hit)           | Peer room  | An agents' exchange ended                                      | Team exchange API                                                                  | turn bound hit     |
| [`grant_decision`](#grant_decision)           | Connectors | A grant check allowed, paused or refused a connector tool call | Tool broker                                                                        | grant              |
| [`task_wake_recorded`](#task_wake_recorded)   | Board      | A wake was saved on a task                                     | Board lifecycle subscriber                                                         |
| [`task_wake_skipped`](#task_wake_skipped)     | Board      | A saved wake did not start a run, and why                      | Wake pump, team engine                                                             |
| [`task_wake_given_up`](#task_wake_given_up)   | Board      | A saved wake was given up after its replays                    | Wake pump                                                                          |
| [`task_braked`](#task_braked)                 | Board      | A released task waits under the no-progress brake              | Board lifecycle subscriber                                                         |
| [`connector_health`](#connector_health)       | Connectors | A connector's health changed                                   | Connector supervisor                                                               | connector          |

- **Board API** means the board routes the dashboard calls. Board changes made through the [Tasks MCP tools](/reference/mcp-tools) or by the task runner itself update the live board views but are not written to the log as board events.
- **Task runner** runs serve `POST /api/runtimes/:id/run` and agent routine fires on runtimes other than OpenClaw. **Team engine** runs serve team chat and the tasks it delegates. See [How a team works](/intro/how-it-works) for the two paths.
- **Peer room** events concern the agents' peer room behind the [TeamChat server](/reference/mcp-tools#teamchat-server), not the team chat you use in the dashboard.
- Only the server writes events. No API route adds them from outside.

## Error classes

Every failure an `error` event records is sorted into one class by matching its code and message. Anything that matches no class is `Unknown`, which Clawboo treats as a **harness bug**: a failure its run machinery could not explain, worth a look rather than routine noise.

| Class             | Meaning                                                                             | Matches, for example (case-insensitive)                                                                                                                                                                                                              | Harness bug |
| ----------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `Billing`         | The provider refused the account: billing, credit, a hold or a pending verification | `billing error`, `account on hold`, `verification required`, `credit balance`, `insufficient quota`, `insufficient credits`, `payment required`, `402`                                                                                               | No          |
| `Auth`            | The runtime's sign-in was refused: a missing, revoked or expired key or login       | `401`, `403`, `authentication failed`, `authentication error`, `permission error`, `invalid api key`, `incorrect api key`, `unauthorized`, `not logged in`, `run /login`, `token has expired`, `sign in again`                                       | No          |
| `RateLimited`     | The provider throttled the request                                                  | `429`, `rate limit`, `too many requests`, `resource exhausted`, `quota`, `usage limit`                                                                                                                                                               | No          |
| `UserAborted`     | A person or Clawboo stopped the run                                                 | `abort`, `aborted`, `cancel`, `cancelled`, `sigint`, `sigterm`                                                                                                                                                                                       | No          |
| `Timeout`         | Something took too long                                                             | `timeout`, `timed out`, `etimedout`, `deadline exceeded`                                                                                                                                                                                             | No          |
| `UnexpectedEnv`   | The machine was missing something                                                   | `enoent`, `eacces`, `eperm`, `command not found`, `permission denied`, `not installed`, `cannot find module`, `sandbox error`                                                                                                                        | No          |
| `ContextOverflow` | The prompt was too long for the model                                               | `context length`, `context window`, `prompt is too long`, `maximum context`, `too many tokens`                                                                                                                                                       | No          |
| `InvalidArgs`     | The request was malformed or refused by a policy                                    | `400`, `422`, `invalid argument`, `bad request`, `validation`, `missing required`, `schema`, `malformed`, `model not found`, `content policy`                                                                                                        | No          |
| `ProviderError`   | The provider failed or could not be reached                                         | `500`, `502`, `503`, `504`, `provider error`, `upstream`, `overloaded`, `service unavailable`, `bad gateway`, `server error`, `api error`, `econnreset`, `econnrefused`, `fetch failed`, `network error`, `connection failed`, `stream disconnected` | No          |
| `Unknown`         | Nothing matched, or the error had no text                                           | Anything else                                                                                                                                                                                                                                        | Yes         |
| `PolicyDenied`    | A guardrail refused a call (expected)                                               | Task-runner runs only; see [PolicyDenied](#policydenied)                                                                                                                                                                                             | No          |

The classes are tried in the order of the table. `Billing` and `Auth` come first: a provider can send an empty balance as a 429 that names its quota, a revoked key as a 400, and an account on hold as a 403. A code in snake_case is also read word by word, so `rate_limit_error` matches `rate limit`. The runtimes put the cause they know on the error's code: Claude Code the SDK's (`authentication_failed`, `billing_error`, `rate_limit`, ...), Codex the app-server's, in the same words where they mean the same thing, and Hermes the `code` or `type` of the provider error it printed.

Two groups of classes change what happens next:

- **Account failures** (`Auth`, `Billing`): a retry fails the same way until a person fixes the sign-in or the account. The task runner never refires the task, the team engine tells the delegator not to hand it out again, and the board shows **Fix sign-in** on the task in **Needs you**. The class is stored on the run's ledger row (`execution_processes.error_class`).
- **Failures that may pass** (`RateLimited`, `Timeout`, `ProviderError`): a routine keeps its schedule through up to three of these in a row. See [Routines](/using/routines#when-a-routine-stops).

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

Board events carry the task in `taskId` and its team in `teamId`. Those written by the board routes the dashboard calls also carry `person`, `{ id: string; name: string | null; role: string | null }`, when the request came through a [sign-in proxy](/guides/sso-proxy) whose identity token Clawboo verified. Without one there is no `person` field.

### task_created

A task was created.

```ts
{
  title?: string | null
  status?: string
  parentTaskId?: string | null
  priority?: string | null
  person?: { id: string; name: string | null; role: string | null }
}
```

### task_claimed

An agent was given a task, by a claim or an assignment.

```ts
{ assigneeAgentId?: string | null; assigneeRuntime?: string | null; person?: Person }
```

### status_changed

A task moved to another status. `to` is always present.

```ts
{ from?: string | null; to: string; by?: 'person'; person?: Person }
```

`Person` is the `person` shape above. Some writers add fields the typed shape does not declare:

- `by: 'person'` marks a move a person made on the board, and `person` names them when a sign-in proxy vouched for them.
- `reason` says why the server moved it: `retry` (a person pressed Retry), `assigned` (a person assigned the task), `blocker_failed` (a task it waited on failed or was cancelled, so it was cancelled too), `verification_exhausted` (its checks failed and the fix attempts ran out), `agent_blocked` (a task runner run's own agent blocked the task), `check_interrupted` (a task runner's check never reached a verdict), `rerun_not_started` (a rerun through the task runner could not start), or `routine_fire_failed` (a routine's run failed and its task was set aside).

### comment_added

A comment or system note landed on a task.

```ts
{ authorType?: string; body?: string; person?: Person }
```

### dep_linked

A task was made to wait for another. The task that waits is `taskId`.

```ts
{ dependsOnTaskId: string; person?: Person }
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
| `budget_held:<scope>`     | `cancelled`             | Right before the model call, a hard cap's remaining room was held by runs already going, so the run did not start    |
| `circuit_broken:<reason>` | `cancelled`             | A circuit breaker stopped the run; see the reasons below                                                             |
| Anything else             | `failed` or `cancelled` | The run's own error summary                                                                                          |

The two budget rows also carry `errorClass` `BudgetRefused`: their status is `cancelled`, but no person stopped them, and a raised cap lets a wake on the task go out.

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

Every approval card is a row in the `tool_call_approvals` table, shown under **Needs you** on the Board (see [Approvals](/using/approvals)). Each row writes one `approval_requested` when it is created and one `approval_resolved` when it settles. The events name the call but never carry its arguments, its reason or the command text: those stay on the row, because nothing prunes the event log and every **Activity** feed reads it.

The envelope carries the agent that asked, its team when Clawboo has a row for that agent, the task the approval gates when known, and the tenant.

To follow approvals as they happen instead of polling the queue, open `GET /api/obs/stream?kinds=approval_requested,approval_resolved`. See [Following approvals](/reference/rest-api/observability#following-approvals).

### approval_requested

An approval card opened: a connector call the tool broker paused, a [Clawboo Native command](/using/command-permissions), a risky hand-off, or an OpenClaw command the server copied from the Gateway. A request the Gateway delivers twice writes one event.

```ts
{
  approvalId: string
  kind: string // 'tool' (Clawboo holds the call) | 'exec' (the OpenClaw Gateway holds it)
  toolName: string // 'run_command' for a Native command, 'exec' for an OpenClaw one, 'delegate:<kind>' for a hand-off
  toolClass?: string | null // 'read' | 'write' | 'destructive'
  grantId?: string | null
  connectorId?: string | null
  expiresAt: number // epoch ms; the card stops being answerable then
  scopeKey?: string // declared; nothing writes it
}
```

A connector call that a remembered **Always** answers opens no card and writes no `approval_requested`. Its [`grant_decision`](#grant_decision) carries the rule's `ruleId`.

### approval_resolved

An approval card settled. Written by whichever of these got there first:

- **A person's answer** through `POST /api/tools/approvals/:id/resolve` or `POST /api/capabilities/approve`. For an OpenClaw command, only once the Gateway has accepted it.
- **Another surface's answer** to an OpenClaw command, which the Gateway reports to Clawboo's server.
- **An OpenClaw deadline.** Every 30 seconds the server expires copied commands past the Gateway's deadline.
- **A wait that ended unanswered.** A connector call, Clawboo Native command or risky hand-off that nobody answered is expired as soon as its wait ends, normally at the card's `expiresAt`.
- **A stopped run.** A Clawboo Native command whose run stopped before anyone answered is expired.
- **The approval reaper**, which runs hourly and expires pending approvals older than 24 hours (`CLAWBOO_APPROVAL_TTL_MS`).

A second answer to the same card changes nothing and writes nothing.

```ts
{
  approvalId: string
  decision: string // 'allow_once' | 'allow_always' | 'deny' | 'expired'; 'resolved' when the Gateway reported an answer without naming it
  kind: string
  toolName: string
  resolvedBy?: { id: string; name: string | null; role: string | null }
}
```

`resolvedBy` names the person who answered, when their request came through a [sign-in proxy](/guides/sso-proxy) whose identity token Clawboo verified. It is absent otherwise, and on an OpenClaw command's event when the Gateway's own report settled the card before Clawboo heard back; the approval row still records who answered then.

A connector call, Native command or hand-off card (`kind: 'tool'`) stays pending past its `expiresAt` only when nothing was left waiting on it, for example because Clawboo stopped while the card was open. The dashboard stops showing it at `expiresAt`. A late answer to it is refused and expires it at once; otherwise the reaper expires it 24 to 25 hours after it was created, with the default `CLAWBOO_APPROVAL_TTL_MS`. An OpenClaw command's copy (`kind: 'exec'`) can stay pending for up to 30 seconds past its `expiresAt`, until the next sweep. An answer to it in that time goes to the Gateway, which decides whether it still counts.

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

The fire failed. A failure that may pass by itself (a run that failed as `RateLimited`, `Timeout` or `ProviderError`) leaves the routine on its schedule, up to three in a row; any other failure stops it in an error state until someone resumes it. `stopped` says which happened.

```ts
{
  scheduledRunId: string
  code?: string | null // declared but not written
  message: string
  errorClass?: string // the failure's class, when the fire ran far enough to have one
  stopped?: boolean // true when the routine stopped on this failure
}
```

| `message`, for example                             | Meaning                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `dispatch refused: <reason>`                       | The task runner refused the run: `workspace_unavailable`, `budget_paused`, `budget_held`, `too_deep`, `connected_substrate` or `not_found` |
| `run <reason>: <summary>`                          | The run ended without success; `<reason>` is `max_turns`, `aborted` or `error`                                                             |
| `The agent "<name>" was removed.`                  | The routine's agent is archived                                                                                                            |
| `agent <id> not found`                             | The routine's agent no longer exists                                                                                                       |
| `The team "<name>" is archived.`                   | A team routine's team is archived                                                                                                          |
| `The team this routine posts to no longer exists.` | A team routine's team was deleted                                                                                                          |
| `invalid task template`                            | The stored routine could not be read                                                                                                       |
| `dispatch failed`                                  | The dispatch failed without a message                                                                                                      |

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

| `reason`            | `decision`         | Meaning                                                                                              |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `no-grant`          | `deny`             | No grant gives this agent, its team, or every agent the connector                                    |
| `grant-revoked`     | `deny`             | The grant was revoked                                                                                |
| `grant-suspended`   | `deny`             | The grant is suspended                                                                               |
| `grant-proposed`    | `deny`             | The grant was proposed but not approved                                                              |
| `grant-expired`     | `deny`             | The grant has expired                                                                                |
| `spec-drift`        | `deny`             | The connector's definition or tool list changed since the grant was made                             |
| `tool-not-in-scope` | `deny`             | The grant's tool allow and deny lists exclude this tool                                              |
| `mode-insufficient` | `deny`             | The tool needs a higher grant mode (`read`, then `write`, then `admin` for destructive tools)        |
| `rate-limited`      | `deny`             | The grant's hourly call limit was reached                                                            |
| `lethal-trifecta`   | `require_approval` | The tool can read private data, take in untrusted content and send data out. Never remembered        |
| `tainted-run`       | `require_approval` | Defined, but nothing marks a run tainted, so it does not occur                                       |
| `standing-deny`     | `deny`             | A remembered "deny" rule matched                                                                     |
| `never-remembered`  | `require_approval` | This tool always asks, even with a remembered "Always" on file                                       |
| `policy-always`     | `require_approval` | The grant asks for approval on every call, even with a remembered "Always" on file. Never remembered |
| `policy-writes`     | `require_approval` | The grant asks for approval on every call that changes something                                     |
| `risk-destructive`  | `require_approval` | The tool is destructive                                                                              |
| `risk-external`     | `require_approval` | The tool acts outside Clawboo and changes something                                                  |

A call the grant check allows can still ask for approval later in the broker, for example a destructive tool. See [Connectors](/using/connectors) and [Approvals](/using/approvals).

### connector_health

A connector's health changed.

```ts
{ connectorId: string; health: string; detail?: string | null; failures?: number }
```

`health` is one of `unknown`, `ok`, `needs-auth`, `degraded`, `error` or `drift`. The server writes this event with `health: 'error'` and `detail: 'the connector process exited'` when a connector's process stops; it writes no other value today. `drift` means the connector's tools no longer match what was approved, so review what changed before trusting it again.

### task_wake_recorded

Something happened on a task and its agent is to hear it: a [saved wake](/internals/board-internals#saved-wakes).

```ts
{
  reason: string
}
```

`reason` is `person_comment`, `dependency_done`, `question_answered` or `reopened`. A wake a stdio bin saved has no event: the bus is in-process.

### task_wake_skipped

A saved wake did not start a run. One event each time the reason changes, however many pump passes it spans.

```ts
{
  wakeId: string
  reason: string
  wakeReason: string
}
```

`wakeReason` is why it was saved. `reason` is what it waits for:

| Reason                     | What ends it                                                |
| -------------------------- | ----------------------------------------------------------- |
| `held`                     | The engine hold lifting                                     |
| `budget`                   | A person raising the hard cap                               |
| `braked`                   | The wait running out, or a person's comment                 |
| `agent_busy`               | The agent's other work ending                               |
| `run_live`                 | A run proven alive holds the task, and takes it             |
| `run_unproven`             | The stale sweep ending a run nothing proves alive           |
| `no_run`                   | A person moving the card: in progress with no run behind it |
| `under_check`              | The work check answering                                    |
| `dependency`               | The dependency finishing                                    |
| `parked`, `stopped`        | A person's Retry                                            |
| `sign_in`, `billing`       | A person fixing it, then a Retry                            |
| `blocked`                  | A person's Retry                                            |
| `person_assigned`          | The person giving the task back to its agent                |
| `question`                 | The person answering, or moving the task on                 |
| `backlog`                  | A person moving the card to To do                           |
| `no_agent`                 | A person assigning an agent                                 |
| `room_archived`, `no_team` | The boot move, or nothing: the team is gone                 |

`finished` means the task closed first, and the wake was settled. The task drawer shows the waiting reason beside the reply box.

### task_wake_given_up

A saved wake's run failed 3 times over, so it stopped being sent. The team's chat was told first; the comments and results stay on the task.

```ts
{
  wakeId: string
  wakeReason: string
  replays: number
}
```

### task_braked

A task released with no visible progress on its last runs waits before it starts again by itself. See [the no-progress brake](/internals/board-internals#the-no-progress-brake).

```ts
{
  runs: number
  until: number
}
```

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
