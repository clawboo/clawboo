---
title: "@clawboo/obs"
description: Pure observability primitives: typed orchestration-event schema, runtime-error taxonomy, graph + fleet-health projection reducers, metric folds, and the structured-output judge drive.
---

- **Version** `0.1.0`
- **Purity** pure zero-dep (browser-safe; only external dep is `zod`, no `node:*` / OTel / DB / network)
- **Purpose** The typed substrate every observability surface shares: the orchestration-event Zod schema, the runtime-error taxonomy, the pure graph + fleet-health projection reducers, metric folds, and the adapter-agnostic structured-output judge drive.
- **Workspace deps** none
- **External deps** `zod` `^3.25.0`

The OTel SDK is NEVER imported here; it is lazy-loaded server-side only when an OTLP endpoint is configured. DB persistence (`appendEvent`/`listEvents`) lives in `@clawboo/db`; the gated emit/trace helpers live in `apps/web/server/lib/obs`. This package is purely the schema + pure-fold layer.

The barrel re-exports six module groups: `./events/schema`, `./log/schema`, `./taxonomy/errors`, `./project/graph`, `./metrics`, `./judge/drive`. The package exposes a single `.` entry point (no subpath exports).

## Public API

### Functions

| Signature                                                                                       | Contract                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseOrchestrationEvent(value: unknown): OrchestrationEvent`                                   | Validate (strict envelope, open `data`) and default `data` to `{}` before persistence. Never drops an event on a `data`-shape mismatch.                                           |
| `classifyError(code?: string \| null, message?: string \| null): RuntimeErrorClass`             | First-matching-rule classification over `code + message`; returns `Unknown` when nothing matches (empty input ⇒ `Unknown`).                                                       |
| `isHarnessBug(cls: RuntimeErrorClass): boolean`                                                 | True iff `cls === 'Unknown'`, an unknown class is an alertable harness defect.                                                                                                    |
| `isUnexpectedFor(runtime: string \| null \| undefined, cls: RuntimeErrorClass): boolean`        | True when `cls` is outside the runtime's expected baseline (always true for `Unknown`); unknown runtimes fall back to the generic baseline.                                       |
| `projectGraph(events: readonly OrchestrationEvent[]): ProjectedGraph`                           | Pure fold of a seq-ordered event list into the task-delegation graph + the derived agent graph (cost reconciled per run; `cost` events incremental, `execution_completed` final). |
| `projectFleetHealth(events, now: number, opts?: FleetHealthOptions): Map<string, AgentHealth>`  | Pure, time-sensitive fold into the fleet-health triage taxonomy, an agent with an open execution is `working`/`stalled`/`zombie` by quiet time, else `idle`.                      |
| `summarizeMetrics(events: readonly OrchestrationEvent[]): ObsMetrics`                           | Aggregate cost/tokens (reconciled per run), tool-error rate, per-kind counts, active agents, and output-tokens-per-minute over the observed window.                               |
| `extractJsonBlock(text: string): unknown \| null`                                               | Extract the first balanced top-level `{…}` JSON object from model text; `null` when absent or unparseable.                                                                        |
| `driveStructuredJudge<S>(input: DriveStructuredJudgeInput<S>): Promise<JudgeResult<TypeOf<S>>>` | Run a judge and parse to a typed verdict with a way-out: empty ⇒ `empty`, valid+typed ⇒ `parsed`, else `unparseable`. Never throws on bad model output.                           |
| `buildJudgePrompt(opts: JudgePromptOptions): string`                                            | Build a "builder ≠ judge, output ONLY JSON of `<shape>`, answer Unknown rather than hallucinate" prompt (used by the eval model-grader).                                          |

### Types & interfaces

**events / log**

| Name                      | Shape / contract                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrchestrationEventKind`  | Union of the 23 `ORCHESTRATION_EVENT_KINDS` literals.                                                                                                                       |
| `OrchestrationEventInput` | `z.input` of `orchestrationEventSchema`, producer side (`seq`/`data` optional).                                                                                             |
| `OrchestrationEvent`      | `z.infer` of `orchestrationEventSchema`: `{ id, seq?, ts, kind, teamId?, taskId?, agentId?, runtime?, traceId?, spanId?, parentSpanId?, correlationId?, tenantId?, data }`. |
| `KindToData`              | Mapping from each kind → its typed `data` interface (producers + reducers stay typed).                                                                                      |
| `TypedEvent<K>`           | Producer-side typed event: `{ kind: K; data: KindToData[K] }` + the partial envelope (sans `kind`/`data`).                                                                  |
| `TaskCreatedData`         | `{ title?; status?; parentTaskId?; priority? }`.                                                                                                                            |
| `TaskClaimedData`         | `{ assigneeAgentId?; assigneeRuntime? }`.                                                                                                                                   |
| `StatusChangedData`       | `{ from?; to: string }`.                                                                                                                                                    |
| `CommentAddedData`        | `{ authorType?; body? }`.                                                                                                                                                   |
| `DepLinkedData`           | `{ dependsOnTaskId: string }`.                                                                                                                                              |
| `ExecutionStartedData`    | `{ execId: string; executorType?; runReason? }`.                                                                                                                            |
| `ExecutionCompletedData`  | `{ execId; status; costUsd?; inputTokens?; outputTokens?; error? }`.                                                                                                        |
| `ToolCallData`            | `{ toolCallId; name; input? }`.                                                                                                                                             |
| `ToolResultData`          | `{ toolCallId; name; isError: boolean; output? }`.                                                                                                                          |
| `CostData`                | `{ costUsd?; inputTokens?; outputTokens?; model? }`.                                                                                                                        |
| `ApprovalRequestedData`   | `{ approvalId?; scopeKey?; kind? }`.                                                                                                                                        |
| `ApprovalResolvedData`    | `{ approvalId?; decision? }`.                                                                                                                                               |
| `ErrorEventData`          | `{ code?; message; errorClass; harnessBug; fatal? }`.                                                                                                                       |
| `SpanStartData`           | `{ name; spanKind?: 'task' \| 'tool' \| 'run' }`.                                                                                                                           |
| `SpanEndData`             | `{ name; status?: 'ok' \| 'error'; durationMs? }`.                                                                                                                          |
| `SessionRotatedData`      | `{ from; to; reason: 'max_turns' \| 'context_watermark'; tokensUsed?; rotationIndex? }`.                                                                                    |
| `RoutineFiredData`        | `{ scheduledRunId; cronSpec; scheduledBy }`.                                                                                                                                |
| `RoutineDispatchedData`   | `{ scheduledRunId; taskId; runtime; dispatchPath: 'one-shot' \| 'connected' \| 'human' }`.                                                                                  |
| `RoutineCompletedData`    | `{ scheduledRunId; taskId?; status; nextRunAt? }`.                                                                                                                          |
| `RoutineErrorData`        | `{ scheduledRunId; code?; message }`.                                                                                                                                       |
| `TeamChatPostData`        | `{ roomId; seq; authorAgentId; postKind: 'peer' \| 'system' \| 'user' }`.                                                                                                   |
| `SpeakerSelectedData`     | `{ roomId; speakerAgentId; policy: 'leader-nominated' \| 'round-robin'; exchangeTurn }`.                                                                                    |
| `TurnBoundHitData`        | `{ roomId; reason: 'max_turns' \| 'no_pending_obligation'; maxExchangeTurns; turnsTaken }`.                                                                                 |
| `LogLevel`                | `z.infer` of `logLevelSchema`: `'debug' \| 'info' \| 'warn' \| 'error'`.                                                                                                    |
| `StructuredLogEntry`      | `{ ts, level, component, action, durationMs?, input?, output?, error?, correlationId, traceId?, spanId?, taskId?, agentId?, runtime? }`.                                    |

**taxonomy**

| Name                | Shape / contract                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `RuntimeErrorClass` | `'InvalidArgs' \| 'Timeout' \| 'ProviderError' \| 'RateLimited' \| 'UserAborted' \| 'UnexpectedEnv' \| 'Unknown'`. |

**project / graph**

| Name                 | Shape / contract                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ProjectedTaskNode`  | `{ id, title \| null, status, assigneeAgentId \| null, parentTaskId \| null, runtime \| null, teamId \| null, costUsd }`. |
| `ProjectedAgentNode` | `{ id, costUsd, taskIds: string[] }`.                                                                                     |
| `ProjectedEdge`      | `{ id, source, target, kind: 'delegation' \| 'dependency' }`.                                                             |
| `ProjectedGraph`     | `{ tasks: ProjectedTaskNode[]; taskEdges: ProjectedEdge[]; agents: ProjectedAgentNode[]; agentEdges: ProjectedEdge[] }`.  |
| `AgentHealthStatus`  | `'working' \| 'idle' \| 'stalled' \| 'zombie'`.                                                                           |
| `AgentHealth`        | `{ status: AgentHealthStatus; lastEventTs; activeTaskId \| null; openExecutions; costUsd }`.                              |
| `FleetHealthOptions` | `{ stallMs?; zombieMs? }`, quiet-time thresholds (defaults 5 min / 30 min).                                               |

**metrics**

| Name         | Shape / contract                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `ObsMetrics` | `{ totalCostUsd, inputTokens, outputTokens, toolErrorRate, toolCalls, toolErrors, eventCounts, activeAgents, tokensPerMinute }`. |

**judge / drive**

| Name                                              | Shape / contract                                              |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `JudgeStatus`                                     | `'parsed' \| 'empty' \| 'unparseable'`.                       |
| `JudgeResult<T>`                                  | `{ raw: string; value: T \| null; status: JudgeStatus }`.     |
| `DriveStructuredJudgeInput<S extends ZodTypeAny>` | `{ runText: () => Promise<string>; schema: S }`.              |
| `JudgePromptOptions`                              | `{ task: string; shape: string; rubric?; notes?: string[] }`. |

### Constants

| Name                           | Value / contract                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORCHESTRATION_EVENT_KINDS`    | The 23 event-kind literals (`task_created` … `turn_bound_hit`), `as const`.                                                                       |
| `orchestrationEventKindSchema` | `z.enum(ORCHESTRATION_EVENT_KINDS)`.                                                                                                              |
| `orchestrationEventSchema`     | zod object for the event envelope, strict fields, open `data` (`z.record`, defaults `{}`).                                                        |
| `logLevelSchema`               | `z.enum(['debug','info','warn','error'])`.                                                                                                        |
| `structuredLogEntrySchema`     | zod object for `StructuredLogEntry`.                                                                                                              |
| `RUNTIME_ERROR_CLASSES`        | The 7 error-class literals, `as const`.                                                                                                           |
| `BASELINE_EXPECTED_CLASSES`    | `Record<runtime, RuntimeErrorClass[]>`, per-runtime expected baselines (`openclaw`/`claude-code`/`codex`/`hermes`); `Unknown` is never baselined. |

### Classes

None, this package exports only functions, types/interfaces, and constants.

## Used by

- **`@clawboo/db`**: `events/appendEvent.ts` + `events/listEvents.ts` (the insert-only event store persisting `OrchestrationEvent`).
- **`@clawboo/evals`**: `graders/model.ts` (the structured-output judge for the model grader) + `graders/code.ts`.
- **`apps/web` (server)**: `lib/obs/{index,logger}.ts` (the gated `emitEvent`/`withTaskSpan`/structured-log helpers), `lib/executorRunner.ts` (error-taxonomy classification + event emit on terminals), `lib/verification/critic.ts` (the shared judge drive), `api/obs.ts` (`/api/obs/*` reads: `projectGraph`/`projectFleetHealth`/`summarizeMetrics`).

## Source

Barrel: [`packages/obs/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/obs/src/index.ts) (re-exports `./events/schema`, `./log/schema`, `./taxonomy/errors`, `./project/graph`, `./metrics`, `./judge/drive`).

## See also

- [Observability: event log, traces, fleet health](/concepts/observability)
- [Orchestration events & error taxonomy](/reference/events-and-errors)
- [Observability REST API](/reference/rest-api/observability)
- [`@clawboo/db`](/reference/packages/db), the DB authority that persists the event log
- [`@clawboo/evals`](/reference/packages/evals), the judge-drive consumer
- [Package overview](/reference/packages/index)
