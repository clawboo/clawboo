---
title: '@clawboo/events'
description: The Bridge → Policy → Handler event pipeline that turns raw Gateway frames into Zustand store mutations.
---

|                    |                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**        | `0.1.1`                                                                                                                                                                    |
| **Purity**         | browser-safe                                                                                                                                                               |
| **Purpose**        | Three-layer pipeline (Bridge → Policy → Handler) that classifies raw OpenClaw Gateway `EventFrame`s, derives pure intents, and dispatches them to injected Zustand stores. |
| **Workspace deps** | `@clawboo/gateway-client`, `@clawboo/logger`, `@clawboo/protocol`                                                                                                          |
| **External deps**  | none                                                                                                                                                                       |

The pipeline is the architectural invariant "all Gateway events go Bridge → Policy → Handler." Bridge parsers and Policy deciders are pure and unit-testable; only the Handler holds state (a debounced summary-refresh timer + a closed-runs TTL guard) and reaches out to injected dispatchers.

## Public API

### Functions

| Export                  | Signature                                                                                                                           | Contract                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processEvent`          | `(frame: EventFrame, handler: EventHandlerHandle) => void`                                                                          | Convenience runner: `classifyEvent` → `derivePolicy` → `handler.applyIntents`. The full pipeline in one call.                                                                                             |
| `classifyEvent`         | `(frame: EventFrame) => ClassifiedEvent`                                                                                            | Bridge step 1. Maps a raw frame's `event` field to an `EventKind`, extracts `agentId` / `sessionKey` (from `agent:<id>:` session keys or payload fields). Unrecognized events → `kind: 'unknown'`.        |
| `parseChatPayload`      | `(payload: unknown) => ChatEventPayload \| null`                                                                                    | Validates a `chat` payload: requires `runId` + `sessionKey` + a `state` of `delta`/`final`/`aborted`/`error`. Returns `null` if malformed.                                                                |
| `parseAgentPayload`     | `(payload: unknown) => AgentEventPayload \| null`                                                                                   | Validates an `agent` payload: requires `runId`. Extracts `seq`, `stream`, `data`, `sessionKey`. Returns `null` if no `runId`.                                                                             |
| `isReasoningStream`     | `(stream: string) => boolean`                                                                                                       | True when the stream name reads as reasoning (`reason`/`think`/`analysis`/`trace`) and not `assistant`/`tool`/`lifecycle`.                                                                                |
| `resolveLifecyclePatch` | `(input: { phase: LifecyclePhase; incomingRunId: string; currentRunId: string \| null; timestamp: number }) => LifecycleTransition` | Pure lifecycle reducer: `start` → running patch; `end`/`error` → terminal patch, but `ignore` when `currentRunId` is set and mismatches `incomingRunId` (stale-run guard).                                |
| `mergeRuntimeStream`    | `(current: string, incoming: string) => string`                                                                                     | Concatenates incoming streaming text onto the current buffer; no-ops on empty input.                                                                                                                      |
| `dedupeRunLines`        | `(seen: Set<string>, lines: string[]) => { appended: string[]; nextSeen: Set<string> }`                                             | Filters out already-seen lines, returns the newly-appended subset plus an updated seen-set (immutable copy).                                                                                              |
| `extractText`           | `(message: unknown) => string \| null`                                                                                              | Re-export of `@clawboo/protocol`. Strips assistant prefix / thinking tags / approval suffix from a message.                                                                                               |
| `extractThinking`       | `(message: unknown) => string \| null`                                                                                              | Re-export of `@clawboo/protocol`. Pulls the thinking trace from block content / tagged streams.                                                                                                           |
| `extractToolLines`      | `(message: unknown) => string[]`                                                                                                    | Re-export of `@clawboo/protocol`. Formats tool calls/results as `[[tool]]` / `[[tool-result]]` markdown lines.                                                                                            |
| `derivePolicy`          | `(event: ClassifiedEvent) => EventIntent[]`                                                                                         | Policy router. Dispatches by `event.kind` to the four deciders below; malformed payloads / unknown kinds → `[{ kind: 'ignore', … }]`.                                                                     |
| `decideAgentEvent`      | `(event: ClassifiedEvent) => EventIntent[]`                                                                                         | Agent-plane decider for `summary-refresh` (presence/heartbeat) → one debounced `scheduleSummaryRefresh` intent (`delayMs: 750`; `includeHeartbeatRefresh` true for `heartbeat`).                          |
| `decideTrustEvent`      | `(event: ClassifiedEvent) => EventIntent[]`                                                                                         | Trust-plane decider for `approval` events → `approvalPending` (`exec.approval.pending`/`.requested`) or `approvalResolved`. Ignores when `agentId` is missing.                                            |
| `decideWorkChatEvent`   | `(event: ClassifiedEvent, payload: ChatEventPayload) => EventIntent[]`                                                              | Work-plane decider for chat frames: `delta` → `queueLivePatch`; `final`/`aborted`/`error` → `clearPendingLivePatch` + `commitChat` (+ a `requestHistoryRefresh` on a final with no thinking trace).       |
| `decideWorkAgentEvent`  | `(event: ClassifiedEvent, payload: AgentEventPayload) => EventIntent[]`                                                             | Work/agent-plane decider for agent streams: `lifecycle` phases → `updateAgentStatus`; reasoning/assistant streams → `queueLivePatch`; tool/unknown streams → `ignore`.                                    |
| `createEventHandler`    | `(deps: EventHandlerDeps) => EventHandlerHandle`                                                                                    | Builds the stateful Handler. Owns a debounced summary-refresh timer + a 30 s / 500-entry closed-runs guard against stale terminal events; dispatches intents to injected store callbacks.                 |
| `createPatchQueue`      | `(onFlush: (patches: Patch[]) => void) => { enqueue: (patch: Patch) => void; flush: () => void; dispose: () => void }`              | RAF-batched per-agent patch merger. Merges updates per `agentId` until the next animation frame; a run-ID change discards the prior streaming state. SSR-guarded (no-op without `requestAnimationFrame`). |

### Types & interfaces

| Export                | Kind      | Contract                                                                                                                                                                                                                                                                                              |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EventKind`           | type      | `'summary-refresh' \| 'runtime-chat' \| 'runtime-agent' \| 'approval' \| 'unknown'`.                                                                                                                                                                                                                  |
| `EventPlane`          | type      | `'work' \| 'agent' \| 'trust'`, which store family an intent targets.                                                                                                                                                                                                                                 |
| `ChatState`           | type      | `'delta' \| 'final' \| 'aborted' \| 'error'`.                                                                                                                                                                                                                                                         |
| `LifecyclePhase`      | type      | `'start' \| 'end' \| 'error'`.                                                                                                                                                                                                                                                                        |
| `ChatEventPayload`    | type      | Parsed `chat` frame: `{ runId, sessionKey, state, seq?, stopReason?, message?, errorMessage? }`.                                                                                                                                                                                                      |
| `AgentEventPayload`   | type      | Parsed `agent` frame: `{ runId, seq?, stream?, data?, sessionKey? }`.                                                                                                                                                                                                                                 |
| `ClassifiedEvent`     | interface | Bridge output: `{ kind, agentId?, sessionKey?, payload, timestamp, raw: EventFrame }`.                                                                                                                                                                                                                |
| `AgentStatusPatch`    | type      | Partial agent state mutation: `{ status?, runId?, runStartedAt?, streamText?, thinkingTrace?, lastActivityAt? }`.                                                                                                                                                                                     |
| `LifecycleTransition` | type      | Discriminated union: `{ kind: 'start'; patch; clearRunTracking: false } \| { kind: 'terminal'; patch; clearRunTracking: true } \| { kind: 'ignore' }`.                                                                                                                                                |
| `EventIntent`         | type      | The pipeline's currency, a discriminated union of `queueLivePatch` / `clearPendingLivePatch` / `commitChat` / `updateAgentStatus` / `scheduleSummaryRefresh` / `requestHistoryRefresh` / `approvalPending` / `approvalResolved` / `ignore`, each tagged with its `plane`.                             |
| `EventHandlerDeps`    | type      | Injected dependencies for `createEventHandler`: state queries (`getConnectionStatus`, `getAgentRunId`), dispatchers (`dispatchIntent`, `queueLivePatch`, `appendOutputLines`, `requestHistoryRefresh`, `loadSummarySnapshot`, `refreshHeartbeatLatest`, …), injectable timers, and an optional `log`. |
| `EventHandlerHandle`  | type      | `{ applyIntents: (intents: EventIntent[], event: ClassifiedEvent) => void; dispose: () => void }`, the Handler's return shape.                                                                                                                                                                        |
| `Patch`               | interface | Patch-queue entry: `{ agentId: string; updates: Record<string, unknown> }`.                                                                                                                                                                                                                           |

<Note>
The package exposes no classes or runtime constants from its barrel; the Bridge and Policy layers are plain functions, and the Handler / patch-queue are factory functions returning closures.
</Note>

## Used by

- `apps/web/src/features/connection/useGatewayEvents.ts`; wires `createEventHandler` + `createPatchQueue` + `processEvent` to the live Gateway stream and the Zustand stores.
- `apps/web/src/stores/fleet.ts`; imports the `AgentStatusPatch` type for its `patchAgent` action.
- `packages/adapters/openclaw/src/mapFrame.ts`; reuses the pure Bridge parsers (`isReasoningStream`, `parseAgentPayload`, `parseChatPayload`) to map Gateway frames into the runtime-event stream.

## Source

Barrel: [`packages/events/src/index.ts`](https://github.com/clawboo/clawboo/tree/main/packages/events/src/index.ts). Layers: `bridge.ts` (parsers), `policy/{index,work,agent,trust}.ts` (deciders), `handler.ts` (dispatch), `patch-queue.ts` (RAF batching), `types.ts` (the shared union types).

## See also

- [Gateway & events pipeline](/concepts/gateway-and-events), the conceptual model.
- [Event pipeline internals](/internals/event-pipeline), Bridge → Policy → Handler in depth.
- [@clawboo/gateway-client](/reference/packages/gateway-client), source of the `EventFrame` type this package consumes.
- [@clawboo/protocol](/reference/packages/protocol), the message parsers re-exported here.
