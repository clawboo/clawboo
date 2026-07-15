---
title: '@clawboo/team-orchestration'
description: 'The pure team-chat orchestration engine: one createBoardOrchestrator core, its BoardClient interface, the nudge queue, delegation-tag parsing, and the shared cascade contract.'
---

- **Version** `0.1.0`
- **Purity** pure, browser-safe (no `node:*`, no I/O; every side effect arrives through injected deps)
- **Purpose** The single engine that turns structured delegation signals into durable board mutations, plus the small pure utilities it needs. Extracted so **one** engine drives every team with no fork.
- **Workspace deps** `@clawboo/executor` (types), `@clawboo/governance` (`checkFanoutCap`)
- **External deps** none
- **Subpath exports** `.` and `./contract`

The engine is deps-injected: the board, delivery, narration, and cost all arrive as functions, so the same core binds server-side (`apps/web/server/lib/teamChat`) against real SQLite and, in tests, against a `FakeBoard`. Team orchestration runs **server-side** for every team; the browser is a thin REST/SSE client.

<Warning>
`deliver` is **not** `runTaskOnRuntime`. The engine owns the board lifecycle: `spawn` does create → claim → `createExecution` → `deliver`, and `completeForSession` does `updateStatus(done)`. A `deliver` that re-claims would 409 and a `deliver` that re-completes would double-complete against the engine. The server binding therefore reuses only adapter construction plus an event drain, piping events to `orchestrator.onEvent`.
</Warning>

## Public API

### The engine (`boardOrchestration.ts`)

| Signature                                              | Contract                                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBoardOrchestrator(deps: BoardOrchestratorDeps)` | Build an orchestrator. Deps supply the board, `deliver`, the known agents, the leader, `narrate`, `onBoardChange`, caps, and the stop generation.                                              |
| `extractSignals(...): ExtractedSignals`                | Pull typed delegation signals from a terminal turn: a `delegate` / `sessions_send` tool-call, or a `<delegate to="@Name">` / `<plan>` directive. **Typed signals only, never prose scraping.** |

Key constants, each a load-bearing invariant:

| Name                         | Value    | Why                                                                                                                                                                     |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_SPAWN_DEPTH`            | `2`      | Bounds the delegation tree via the board ancestor chain, enforced in code rather than by prompt.                                                                        |
| `REFLECT_WINDOW_MS`          | `3000`   | Batches completed tasks into one `[Task Update]` to the leader, the single reduce point.                                                                                |
| `DELEGATION_IDLE_TIMEOUT_MS` | `480000` | The 8-minute idle watchdog: a delegate that goes truly silent fails rather than hanging. Refreshed on every observed event, so a slow-but-working agent never trips it. |
| `MAX_DELEGATION_FAILURES`    | `3`      | A per-`(agent, task)` loop breaker; reset on success.                                                                                                                   |

### The board seam (`boardClient.ts`)

The `BoardClient` interface plus `CreateTaskInput`, `BoardTask`, `ClaimResult`, `TaskDetail`, `ExecutionRef`, `CompleteExecutionOutcome`. `ClaimReason` is `'conflict' | 'not_found' | 'error'`.

<Note>
A `'conflict'` claim means another worker won the race. It is **data, never an error to retry**: the atomic claim is the concurrency primitive, so a 409 is never retried.
</Note>

### Delivery (`nudgeQueue.ts`)

`createNudgeQueue` returns a non-destructive queue: a message to a **busy** session is queued and flushed at its turn boundary, never interrupting an in-flight run. `deliver` marks a session busy synchronously, which closes the double-send race.

### Parsing (`delegationTags.ts`)

`findDelegationBlocks`, `parseStructuredDelegations`, `stripDelegationBlocks`, `detectDelegationIntent`, `findPlanBlocks`, `stripPlanBlocks`, plus `DelegationIntent` / `DelegationBlock` / `PlanStep` / `PlanBlock`.

The matchers are deliberately **drift-tolerant**: the reliable anchor is the closing `</delegate>` plus the `to="…">` attribute shape, so a weaker model that drops the opening `<` is still parsed. Stripping removes the whole tag, so no fragment leaks into rendered prose.

### Reflection (`taskUpdate.ts`)

`buildTaskUpdateMessage(items)` renders the batched leader stimulus. `TaskUpdateOutcome` is `'done' | 'error' | 'aborted' | 'timeout' | 'max_turns'`; a non-`done` outcome renders as a "did not complete" entry, so the leader is told to decide rather than wait.

### Session keys (`sessionUtils.ts`)

`buildTeamSessionKey(agentId, teamId)`, `agentIdFromSessionKey`, `isTeamSessionKey`.

### Control tokens (`controlTokens.ts`)

`shouldDropAssistantTurn` plus `isOpenclawControlToken`, `isClawbooControlToken`, `isLikelyRefusal`, `RESUME_ACK_TOKEN` (`__resumed__`), `SKIP_ACK_TOKEN` (`__skipped__`), `MIN_SUBSTANTIVE_LENGTH`. This is the cascade-safety filter that keeps control tokens and short refusals out of the transcript.

### The contract suite (`./contract`)

`runCascadeContract(harness)` exports the ~42 cascade scenarios (stop-clean-release, the idle watchdog, `sessionToTask` 1:1 serialize-don't-orphan, reflect batching, the fan-out cap, plan-dep cancel-on-fail, loop breakers, dedupe, claim-409-never-retried). `CascadeBoard` keeps scenarios board-agnostic.

It runs against **both** the in-package `FakeBoard` (proving the cascade logic) and the real `serverBoardClient` over SQLite (proving the invariants hold against the real state machine), so a FakeBoard-vs-real divergence is caught.

<Info>
`vitest` is `external` in the build, so the app-safe barrel never pulls the test runner; only the `./contract` subpath does. Same pattern as `@clawboo/executor/contract`.
</Info>

## Used by

- **`apps/web` (server)**; `lib/teamChat/teamOrchestrator.ts` builds one long-lived orchestrator per active team over `createBoardOrchestrator`, with `serverBoardClient` and `serverDeliver` as deps.
- **`apps/web` (server)**; `lib/teamChat/serverDeliver.ts` and `persistTeamChatEntry.ts` consume `sessionUtils` and `controlTokens`.
- **`apps/web` (SPA)**; `lib/teamProtocol.ts` re-exports the control-token helpers so browser consumers are unchanged.

## Source

Barrel: [`packages/team-orchestration/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/team-orchestration/src/index.ts). Contract: [`src/contract.ts`](https://github.com/clawboo/clawboo/blob/main/packages/team-orchestration/src/contract.ts).

## See also

- [Delegation and orchestration](/concepts/delegation-and-orchestration), the model this engine implements
- [The board](/concepts/the-board), the canonical state it mutates
- [`@clawboo/executor`](/reference/packages/executor), the `RuntimeEvent` union it observes
- [`@clawboo/governance`](/reference/packages/governance), the fan-out cap it enforces
- [Board internals](/internals/board-internals)
- [Package overview](/reference/packages/index)
