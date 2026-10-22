---
title: '@clawboo/team-orchestration'
description: 'The pure team-chat orchestration engine: one createBoardOrchestrator core, its BoardClient interface, the nudge queue, delegation-tag parsing, and the shared cascade contract.'
---

- **Version** `0.1.0`
- **Purity** pure, browser-safe (no `node:*`, no I/O; every side effect arrives through injected deps)
- **Purpose** The single engine that turns structured delegation signals into durable board mutations, plus the small pure utilities it needs. Extracted so **one** engine drives every team with no fork.
- **Workspace deps** `@clawboo/board-core` (`TaskStatus`), `@clawboo/executor` (types), `@clawboo/governance` (`checkFanoutCap`)
- **External deps** none
- **Subpath exports** `.` and `./contract`

The engine is deps-injected: the board, delivery, narration, and cost all arrive as functions, so the same core binds server-side (`apps/web/server/lib/teamChat`) against real SQLite and, in tests, against a `FakeBoard`. Team orchestration runs **server-side** for every team; the browser is a thin REST/SSE client.

<Warning>
`deliver` is **not** `runTaskOnRuntime`. The engine owns the board lifecycle: `spawn` does create → claim → `createExecution` → `deliver`, and `completeForSession` does `updateStatus(done)`. A `deliver` that re-claims would 409 and a `deliver` that re-completes would double-complete against the engine. The server binding therefore reuses only adapter construction plus an event drain, piping events to `orchestrator.onEvent`.
</Warning>

## Public API

### The engine (`boardOrchestration.ts`)

| Signature                                              | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBoardOrchestrator(deps: BoardOrchestratorDeps)` | Build an orchestrator. Deps supply the board, `deliver`, the known agents, the leader, `narrate`, `onBoardChange`, caps, the stop generation, and `isSessionBusy`. The orchestrator it returns also exposes `detachTask(taskId)`, which a host calls when a task was released out of band (the stale sweep, an orphan reap) so the engine stops holding a session against work nobody runs; it returns `false` while a live run still owns that session. |
| `extractSignals(...): ExtractedSignals`                | Pull typed delegation signals from a terminal turn: a `delegate` / `sessions_send` tool-call, or a `<delegate to="@Name">` / `<plan>` directive. **Typed signals only, never prose scraping.**                                                                                                                                                                                                                                                           |

A person's move on the board goes through `personMovedTask(taskId, to, { cancelledDependents? })` instead of `detachTask`; the host calls it after the move is written. The person's move is the final word on the run working on the task: the engine aborts it (through the optional `abortSession` dep), forgets the session, and closes the execution as `cancelled` with the note `Stopped: a person moved the card to <Status>.` A move to `done` or `cancelled` is reflected to whoever delegated the task with outcome `person_done` or `person_cancelled` (a person-assigned task reports to nobody), and `cancelledDependents`, the plan steps the host cancelled with it, are named in that reflection. A move back to `todo` while the task was running starts it again for the same agent, and a move to `done` runs the ready-pump so steps waiting on it can fire. A run that ends after a person already finished or cancelled its task changes nothing: `completeForSession` and `failForSession` close its execution as `cancelled`, keep a successful result as a `[late result: …]` comment, and tell no one again.

`detachTask` also closes the execution it was tracking as `failed` (`Released before its run started.`) when nothing else had closed it, so a delegation released before its run began does not read as owned forever; the fire policy may re-fire it.

Key constants, each a load-bearing invariant:

| Name                         | Value     | Why                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_SPAWN_DEPTH`            | `2`       | Bounds the delegation tree via the board ancestor chain, enforced in code rather than by prompt. An alias for `DEFAULT_MAX_DEPTH` in `@clawboo/governance`, so it cannot drift from the runner's copy.                                                                                                                                                                                     |
| `REFLECT_WINDOW_MS`          | `3000`    | Batches completed tasks into one `[Task Update]` to the leader, the single reduce point.                                                                                                                                                                                                                                                                                                   |
| `DELEGATION_IDLE_TIMEOUT_MS` | `480000`  | The 8-minute idle watchdog: a delegate that goes truly silent fails rather than hanging. Refreshed on every observed event, so a slow-but-working agent never trips it.                                                                                                                                                                                                                    |
| `PENDING_START_TIMEOUT_MS`   | `1440000` | The 24-minute idle allowance while a delegation's run has not started yet, because it is waiting behind another run on the agent's home or connection lock (the same value as `OPEN_TOOL_CALL_TIMEOUT_MS`). The host bounds that wait with `HOME_MUTEX_ACQUIRE_MS` (10 minutes by default), so this only catches a start that never settles. The idle window restarts when the run starts. |
| `MAX_DELEGATION_FAILURES`    | `3`       | A per-`(agent, task)` loop breaker; reset on success.                                                                                                                                                                                                                                                                                                                                      |

### The board seam (`boardClient.ts`)

The `BoardClient` interface plus `CreateTaskInput`, `BoardTask`, `ClaimResult`, `TaskDetail`, `ExecutionRef`, `ExecutionSummary`, `CompleteExecutionOutcome`. `listExecutions` returns `ExecutionSummary[] | null`, and `null` means the ledger could not be READ, which a caller must treat as "unknown, do nothing this pass" rather than collapsing into `[]`: an empty ledger is the strongest evidence a task is fireable, so a transient read failure would turn a user-Stopped delegation into an auto-fired one. `ClaimReason` is `'conflict' | 'not_found' | 'error'`.

<Note>
A `'conflict'` claim means another worker won the race. It is **data, never an error to retry**: the atomic claim is the concurrency primitive, so a 409 is never retried.
</Note>

### Delivery (`nudgeQueue.ts`)

`createNudgeQueue` returns a non-destructive queue: a message to a **busy** session is queued and flushed at its turn boundary, never interrupting an in-flight run. `deliver` marks a session busy synchronously, which closes the double-send race.

### Parsing (`delegationTags.ts`)

`findDelegationBlocks`, `parseStructuredDelegations`, `stripDelegationBlocks`, `detectDelegationIntent`, `findPlanBlocks`, `stripPlanBlocks`, plus `DelegationIntent` / `DelegationBlock` / `PlanStep` / `PlanBlock`.

The matchers are deliberately **drift-tolerant**: the reliable anchor is the closing `</delegate>` plus the `to="…">` attribute shape, so a weaker model that drops the opening `<` is still parsed. Stripping removes the whole tag, so no fragment leaks into rendered prose.

### Reflection (`taskUpdate.ts`)

`buildTaskUpdateMessage(items, outstanding?, opts?)` renders the batched leader stimulus. `TaskUpdateOutcome` is `'done' | 'person_done' | 'person_cancelled' | 'error' | 'aborted' | 'timeout' | 'max_turns'`. `error`, `aborted`, `timeout` and `max_turns` render as a "did not complete" entry, so the leader is told to decide rather than wait. The two `person_*` outcomes are a person deciding the task on the board and are not failures: `person_done` renders as `✓ Marked done by a person (it was <agent>'s)`, and `person_cancelled` as `✕ Cancelled by a person (it was <agent>'s)` under a header line telling the recipient not to redo cancelled work or hand it to anyone again.

`outstanding` (`OutstandingDelegation[]`) adds one "Still outstanding" header line naming work that has not reported yet, so a partial batch is not read as the complete picture. The engine fills it with the recipient's own unfinished delegations and with any work still running under a task the batch reports as finished, whose results arrive later through a follow-up.

`opts.followUp` (`{ title? }`, from `TaskUpdateOptions`) frames the envelope as a follow-up: the recipient delegated these tasks while on a task that has since closed (named by `title` when known), so its reply is not shown to the user but recorded on that task and passed to whoever gave it the task. The engine sets it only for a recipient that is not the team lead. An omitted or empty `outstanding` or `opts` renders nothing, so an existing call is byte-identical.

### Turn origin (`turnOrigin.ts`)

`TurnOrigin` is stamped by whoever asks for a turn and passed as `deliver`'s fourth argument. It is one of:

- `{ kind: 'human' }`: a person typed into team chat, to the lead or to a specialist they @mentioned.
- `{ kind: 'delegation'; fromAgentId }`: a teammate delegated this task. `fromAgentId` is the delegator, the reduce point its result reports to, or `null` when the engine could not attribute one.
- `{ kind: 'assignment' }`: a person assigned this board task to the agent directly (the board's New task dialog, an explicit assignment, a retry). Its result goes on the task card; no teammate is waiting on it.
- `{ kind: 'system'; forTaskId? }`: Clawboo itself, a batched `[Task Update]`. `forTaskId`, present only when set, marks a follow-up: the recipient delegated this work while on that task, which has since closed. The engine never sets it for the team lead.
- `{ kind: 'schedule'; routineName }`: a routine the person scheduled posted this into team chat on their behalf. It frames like a human turn, but nobody is necessarily watching.

The origin is required rather than inferred: the host used to work out whether a turn was a delegated worker's or the user-facing leader's by asking the engine whether the session still held a task, and that answer goes stale the moment `completeForSession` forgets the session. `HUMAN_TURN`, `SYSTEM_TURN` and `ASSIGNMENT_TURN` are singletons for the payload-free variants.

`classifyTurn({ origin, targetAgentId, leaderAgentId, hasBoardTask })` returns a `TurnFraming` of three independent booleans: `isWorker` (executing a delegated or person-assigned task), `isLeader` (the team's reduce point, a property of who the agent is), and `isUserFacing` (this turn's reply reaches the human, so it may carry the user's self-intro). Three optional fields are present only when they apply: `isUserAssigned` on a person-assigned task, `scheduledRoutine` (the routine's name) on a scheduled turn that is not a worker's, and `reportsForTask` on a follow-up, a `system` origin carrying `forTaskId` delivered to anyone but the lead. A follow-up is none of worker, leader or user-facing, even when the agent holds a task by the time it runs.

`isChatVisible(origin, framing)` answers whether a turn's reply may reach the team chat. It is decided from why the turn was delivered, never from whether the session maps a task when the run starts: `human` and `schedule` are visible, `system` is visible unless the framing has `reportsForTask`, and `delegation` and `assignment` never are. It must never be derived from `isUserFacing`, because a person's @mention to a worker holding a task is framed as a worker turn but is still a reply they asked for.

`RunStamp` (`{ reportForTaskId, stopGen }`) is what a run was delivered as, fixed at delivery: the framing's `reportsForTask` (or `null`) and the host's stop generation at that moment. The host hands it back to the engine with each of the run's events, as the optional third argument of `onEvent(sessionKey, event, run?)` and the second of `onSessionClosed(sessionKey, run?)`. A follow-up's terminal is then recorded on its task and never treated as the session's task run, and a run delivered before a Stop starts no new work. Omitting the stamp (a direct call) means neither.

### Turn envelope (`turnEnvelope.ts`)

`buildTurnEnvelope({ ambient, addressed })` frames a run's waiting context as two channels with different authority: **addressed** items are routed to this agent and need a response; **ambient** items are evidence about the state of the work and carry no authority to change the task, the policies, or the Team Rules. Addressed renders first so a long ambient block cannot bury the ask, and an empty section is omitted entirely so a quiet turn adds zero tokens (returns `null`).

Section membership is clawboo's decision, taken from provenance (the mailbox row's `kind`, and which reader produced the item) and **never** from the text, so a peer's message can never promote itself out of the ambient half. The builder frames items without touching them, which is what keeps `formatPeerPost`'s safety-critical `isUser=false` token intact.

### Session keys (`sessionUtils.ts`)

`buildTeamSessionKey(agentId, teamId)`, `agentIdFromSessionKey`, `isTeamSessionKey`.

### Control tokens (`controlTokens.ts`)

`shouldDropAssistantTurn` plus `isOpenclawControlToken`, `isClawbooControlToken`, `isLikelyRefusal`, `RESUME_ACK_TOKEN` (`__resumed__`), `SKIP_ACK_TOKEN` (`__skipped__`), `MIN_SUBSTANTIVE_LENGTH`. This is the cascade-safety filter that keeps control tokens and short refusals out of the transcript.

### The contract suite (`./contract`)

`runCascadeContract(harness)` exports the 103 cascade scenarios (stop-clean-release, the idle watchdog with its open-tool-call and pending-start allowances, `sessionToTask` 1:1 serialize-don't-orphan, reflect batching, the fan-out cap, plan-dep cancel-on-fail, loop breakers, dedupe, claim-409-never-retried, detach-on-release, `markStopped`, the pump's ledger fire policy, follow-ups on closed tasks, and work delivered before a Stop). `CascadeBoard` keeps scenarios board-agnostic.

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
