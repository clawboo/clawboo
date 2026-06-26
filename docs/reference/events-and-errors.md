---
title: Orchestration events and error taxonomy
description: Reference for the append-only orchestration event kinds and the runtime error classification used across observability.
---

The orchestration **event log** is the append-only stream every observability surface reads. It is simultaneously the always-on local trace store (a trace is all events sharing a `traceId`, ordered by `seq`), the graph-projection source (delegation / status / cost), and the metric + error-taxonomy source. This page is the reference for the two typed contracts that define it: the **event kinds** (the discriminated union in `@clawboo/obs`) and the **runtime error classes** (the Cursor-model classifier).

Both contracts live in `@clawboo/obs`, pure, browser-safe, zero runtime dependency on the OTel SDK. Events are persisted insert-only with secrets scrubbed; one trace per board task, spans per run / tool.

## At a glance

| Contract              | Export                                 | Count                    | Source                                |
| --------------------- | -------------------------------------- | ------------------------ | ------------------------------------- |
| Event kinds           | `ORCHESTRATION_EVENT_KINDS` (`z.enum`) | 23 kinds                 | `packages/obs/src/events/schema.ts`   |
| Correlation envelope  | `orchestrationEventSchema` (Zod)       | 13 fields                | `packages/obs/src/events/schema.ts`   |
| Error classes         | `RUNTIME_ERROR_CLASSES`                | 7 classes                | `packages/obs/src/taxonomy/errors.ts` |
| Classifier            | `classifyError(code, message)`         | regex rules, first-match | `packages/obs/src/taxonomy/errors.ts` |
| Harness-bug predicate | `isHarnessBug(cls)`                    | `Unknown` ⇒ `true`       | `packages/obs/src/taxonomy/errors.ts` |

<Note>
The kinds are an **append-only enum**; kinds are added (e.g. `session_rotated`, the `routine_*` family, the `team_chat_post` family), never renamed or removed, so old traces keep parsing. Each addition lands in `@clawboo/obs` before any emit site.
</Note>

---

## The correlation envelope

Every event, regardless of kind, validates against `orchestrationEventSchema`. The runtime schema validates the envelope **strictly** but treats `data` as an open object (`z.record`), so an emit site can never drop an event on a minor data-shape drift. Observability captures best-effort; the kind → `data` shapes below are TypeScript interfaces (a discriminated union) that keep producers and projection reducers typed without risking event loss at the wire.

```ts
{
  id: string
  seq?: number            // assigned atomically by SQLite on insert (cross-process monotonic)
  ts: number              // emit timestamp (epoch ms)
  kind: OrchestrationEventKind
  teamId?: string | null
  taskId?: string | null
  agentId?: string | null
  runtime?: string | null
  traceId?: string | null      // ties every span/event of one board task together
  spanId?: string | null       // forms the span tree (run span, tool sub-spans)
  parentSpanId?: string | null
  correlationId?: string | null
  tenantId?: string | null     // future seam: dormant multi-tenant scoping
  data: Record<string, unknown>  // open by design; defaults to {}
}
```

| Field                                 | Role                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                                  | Stable event id (filled by the emit helper).                                                                         |
| `seq`                                 | Cross-process monotonic, never reused. Assigned by SQLite, optional on the producer side. Traces order by `seq ASC`. |
| `ts`                                  | Emit timestamp (epoch ms).                                                                                           |
| `kind`                                | The discriminant, one of the 23 [event kinds](#event-kinds).                                                         |
| `traceId` / `spanId` / `parentSpanId` | The trace + span tree. One trace per board task; a run is a span, tool calls are sub-spans.                          |
| `correlationId`                       | Free-form correlation key (e.g. an execution id) for non-trace grouping.                                             |
| `tenantId`                            | Dormant multi-tenant seam, currently null (single implicit tenant).                                                  |
| `data`                                | Kind-specific payload; open at the wire, typed per kind below.                                                       |

`parseOrchestrationEvent(value)` validates and defaults `data` before persistence.

---

## Event kinds

The 23 members of `ORCHESTRATION_EVENT_KINDS`, grouped by concern. Each `data` shape is the TypeScript interface from `KindToData`. Fields without `?` are always present at the producer; `?` fields are optional. `data` is open at the wire, so any consumer must tolerate missing fields.

### Board lifecycle

#### `task_created`

A board task was created.

```ts
{
  title?: string | null
  status?: string
  parentTaskId?: string | null
  priority?: string | null
}
```

#### `task_claimed`

A task was atomically claimed by an assignee.

```ts
{
  assigneeAgentId?: string | null
  assigneeRuntime?: string | null
}
```

#### `status_changed`

A task transitioned state. `to` is always present; `from` may be null (first transition).

```ts
{
  from?: string | null
  to: string
}
```

#### `comment_added`

A comment / system note landed on a task.

```ts
{
  authorType?: string
  body?: string
}
```

#### `dep_linked`

A dependency edge (`blocks` / `blocked-by`) was added.

```ts
{
  dependsOnTaskId: string
}
```

### Execution

#### `execution_started`

An execution process opened for a task run.

```ts
{
  execId: string
  executorType?: string
  runReason?: string | null
}
```

#### `execution_completed`

An execution closed with its outcome. The `costUsd` / token fields carry the run's **final total** (authoritative for the run, see [cost reconciliation](#cost-reconciliation)).

```ts
{
  execId: string
  status: string
  costUsd?: number | null
  inputTokens?: number
  outputTokens?: number
  error?: string | null
}
```

#### `tool_call`

A runtime invoked a tool. `toolCallId` correlates with the matching `tool_result`.

```ts
{
  toolCallId: string
  name: string
  input?: unknown
}
```

#### `tool_result`

A tool returned. `isError` drives the tool-error-rate metric.

```ts
{
  toolCallId: string
  name: string
  isError: boolean
  output?: string
}
```

#### `cost`

An incremental cost/token tick during a run. These accumulate per run; see [cost reconciliation](#cost-reconciliation).

```ts
{
  costUsd?: number | null
  inputTokens?: number
  outputTokens?: number
  model?: string | null
}
```

### Approvals

#### `approval_requested`

A tool / delegation approval was requested.

```ts
{
  approvalId?: string
  scopeKey?: string
  kind?: string
}
```

#### `approval_resolved`

An approval was resolved (allow / deny / expire).

```ts
{
  approvalId?: string
  decision?: string
}
```

### Errors

#### `error`

A runtime / tool failure. The `errorClass` and `harnessBug` fields are filled at the emit site by running the failure through [`classifyError`](#error-taxonomy) and [`isHarnessBug`](#error-taxonomy). A `harnessBug: true` event additionally fires a structured harness-bug alert.

```ts
{
  code?: string | null
  message: string
  errorClass: string   // a RuntimeErrorClass, or 'PolicyDenied' for a non-error policy denial
  harnessBug: boolean  // classifyError(...) === 'Unknown'
  fatal?: boolean
}
```

<Note>
`errorClass` is typed `string` (not the `RuntimeErrorClass` union) because the executor runner also emits `PolicyDenied` for a brokered-tool denial, a non-fatal denial path that is not a runtime failure. Every other value is one of the seven [error classes](#error-taxonomy).
</Note>

### Spans

#### `span_start`

Opens a span in the trace tree.

```ts
{
  name: string
  spanKind?: 'task' | 'tool' | 'run'
}
```

#### `span_end`

Closes a span.

```ts
{
  name: string
  status?: 'ok' | 'error'
  durationMs?: number
}
```

### Session rotation

#### `session_rotated`

A run rotated to a fresh successor session (context exhaustion / max-turns). Continuity rides a short handoff note, not the transcript.

```ts
{
  from: string          // predecessor session stream key
  to: string            // successor session stream key
  reason: 'max_turns' | 'context_watermark'
  tokensUsed?: number   // tokens the predecessor consumed before rotating
  rotationIndex?: number // 1-based rotation index within the task's run chain
}
```

### Routines (scheduler)

#### `routine_fired`

A `scheduled_runs` ledger row fired.

```ts
{
  scheduledRunId: string
  cronSpec: string
  scheduledBy: string // the firing owner of record ('clawboo' for the Routines engine)
}
```

#### `routine_dispatched`

A fire materialized (or bound to) a board task and dispatched it. `dispatchPath` records the wake-bridge branch.

```ts
{
  scheduledRunId: string
  taskId: string
  runtime: string
  dispatchPath: 'one-shot' | 'connected' | 'human'
}
```

#### `routine_completed`

A fire's dispatch reached a terminal outcome. `nextRunAt` is null when disarmed (a spent `once@` or an errored recurring routine).

```ts
{
  scheduledRunId: string
  taskId?: string | null
  status: string
  nextRunAt?: number | null
}
```

#### `routine_error`

A fire failed (the routine is parked / disarmed until a human resumes).

```ts
{
  scheduledRunId: string
  code?: string | null
  message: string
}
```

### Peer chat

#### `team_chat_post`

A post landed in a team room. `authorAgentId` is resolved from the MCP connection binding, never from tool args (anti-spoof).

```ts
{
  roomId: string
  seq: number // per-room monotonic ordering key assigned at write time
  authorAgentId: string
  postKind: 'peer' | 'system' | 'user' // peer = teammate post; system = board-mutation narration
}
```

#### `speaker_selected`

The speaker-selection policy nominated the next agent to talk in a bounded exchange.

```ts
{
  roomId: string
  speakerAgentId: string
  policy: 'leader-nominated' | 'round-robin'
  exchangeTurn: number // 1-based turn index within the current bounded exchange
}
```

#### `turn_bound_hit`

A bounded peer-chat exchange ended (the chatter-forever guard).

```ts
{
  roomId: string
  reason: 'max_turns' | 'no_pending_obligation'
  maxExchangeTurns: number // the cap that bounded the exchange
  turnsTaken: number // how many peer turns the exchange actually ran
}
```

---

## Cost reconciliation

`cost` events are incremental and `execution_completed` carries the run's **final total**. A runtime that reports cost only at completion (no mid-run `cost` events) would otherwise read `$0` / `0` tokens in the metrics while the graph showed the real total. Both the metrics fold (`summarizeMetrics`) and the graph projection (`projectGraph`) reconcile **per run** (keyed by `taskId`): they take `max(sum of cost events, execution_completed total)`, so the two code paths converge regardless of how a runtime reports cost, no double counting, and the completion total supplies the value when there were no `cost` events at all.

---

## Error taxonomy

Every runtime / tool failure is classified: a failure is mapped to a baseline of **expected** classes; anything that doesn't match is `Unknown`, and an `Unknown` is treated as a **harness bug**, surfaced as an alert (a flagged `error` event plus an error-level structured log) rather than silently swallowed. Expected classes get baselined per runtime so anomalies in their **rate** can be alerted on later; an `Unknown` alerts immediately.

### Classes

`RUNTIME_ERROR_CLASSES`, the seven members of `RuntimeErrorClass`:

| Class           | Matches (case-insensitive)                                                                                                                                     | Harness bug? |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `RateLimited`   | `429`, `rate limit`, `too many requests`, `resource exhausted`, `quota`                                                                                        | No           |
| `UserAborted`   | `abort`, `aborted`, `cancel(led)`, `sigint`, `sigterm`, `user aborted/cancel`                                                                                  | No           |
| `Timeout`       | `timeout`, `timed out`, `etimedout`, `deadline exceeded`                                                                                                       | No           |
| `UnexpectedEnv` | `enoent`, `eacces`, `eperm`, `einval`, `command not found`, `no such file`, `permission denied`, `not installed`, `module not found`, `cannot find module`     | No           |
| `InvalidArgs`   | `400`, `422`, `invalid argument/param/input/request`, `bad request`, `validation`, `unprocessable`, `missing required`, `schema`, `malformed`                  | No           |
| `ProviderError` | `500`/`502`/`503`/`504`, `provider error`, `upstream`, `overloaded`, `service unavailable`, `bad gateway`, `internal server error`, `api error`, `model error` | No           |
| `Unknown`       | nothing matched (or an empty error string)                                                                                                                     | **Yes**      |

### `classifyError(code, message)`

```ts
function classifyError(code?: string | null, message?: string | null): RuntimeErrorClass
```

Joins `code` and `message` into one haystack (`` `${code ?? ''} ${message ?? ''}` ``, trimmed). An empty haystack returns `Unknown`. Otherwise the rules are tried **in order, first match wins** (the order is `RateLimited` → `UserAborted` → `Timeout` → `UnexpectedEnv` → `InvalidArgs` → `ProviderError`), so the more specific / overloaded signals (rate-limit, abort) are checked before the broader provider / env buckets. No match returns `Unknown`.

### `isHarnessBug(cls)`

```ts
function isHarnessBug(cls: RuntimeErrorClass): boolean
```

Returns `true` only for `Unknown`. An unknown class is, by definition, a defect in the harness itself, so it alerts immediately rather than being absorbed as expected noise.

### Per-runtime baselines

`BASELINE_EXPECTED_CLASSES` maps a runtime id to the classes whose mere occurrence is not an alert (only a spike in their rate would be). The baseline for `openclaw`, `claude-code`, `codex`, and `hermes` is identical, the six non-`Unknown` classes (`InvalidArgs`, `Timeout`, `ProviderError`, `RateLimited`, `UserAborted`, `UnexpectedEnv`). Any runtime not in the map (including `clawboo-native`) falls back to `GENERIC_BASELINE`, which is the same six classes. `Unknown` is never in a baseline; it always alerts.

```ts
function isUnexpectedFor(runtime: string | null | undefined, cls: RuntimeErrorClass): boolean
```

`true` when `cls` is unexpected for the runtime: always `true` for `Unknown`, otherwise `true` when `cls` is not in that runtime's baseline.

<Tip>
Because `Unknown` is the only class outside every baseline, an `isUnexpectedFor(...)` of any non-`Unknown` class is currently always `false`. The per-runtime baselines exist so that a future divergence (a runtime that genuinely never rate-limits, say) can flag that class as anomalous without code changes.
</Tip>

---

## How the taxonomy feeds the surfaces

- The executor runner classifies each failure as it drains a run's events, fills `errorClass` + `harnessBug` into the emitted `error` event, and fires a harness-bug alert when the class is `Unknown` (a brokered-tool denial is emitted with `errorClass: 'PolicyDenied'` and `harnessBug: false`, never alerting).
- The observability **error-taxonomy** view breaks `error` events down by class and surfaces the `Unknown`/harness-bug count.
- The **fleet-health** view (`projectFleetHealth`) folds the same log into the fleet-health triage taxonomy `AgentHealthStatus`: `working` / `idle` / `stalled` / `zombie`, by how long an agent has been quiet while an execution is open (`idle` = no open execution; `working`/`stalled`/`zombie` by quiet-time thresholds).
- The **graph projection** (`projectGraph`) folds the log into the task-delegation and agent graphs, applying the same per-run cost reconciliation as the metrics.

See the [observability dashboard](/using/observability-dashboard) for how these render in the UI, and the [observability REST API](/reference/rest-api/observability) for the `/api/obs/*` endpoints that serve the event log, traces, errors, graph, and fleet health.

## See also

- [Observability dashboard](/using/observability-dashboard), traces, errors, fleet health, evals
- [Observability REST API](/reference/rest-api/observability), `/api/obs/*` (events, traces, errors, graph, health, SSE stream)
- [Glossary](/appendices/glossary), builder≠judge, harness bug, trace, span
- [@clawboo/obs](/reference/packages/obs), the package these contracts live in
