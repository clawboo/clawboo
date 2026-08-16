---
title: '@clawboo/db'
description: 'SQLite + Drizzle ORM data layer: schema, board, memory, tools, governance, events, sessions, routines, team-chat.'
---

**Version** 0.1.0 · **Purity** server-only (`better-sqlite3` native binding) · **Purpose** the single SQLite + Drizzle data layer: schema, connection, and every domain repository (board, memory, tools broker, governance, event log, sessions, routines, team-chat). It is the cross-process bus: the Express server and the MCP stdio bins open the same file.

**Workspace deps** `@clawboo/board-core`, `@clawboo/compaction`, `@clawboo/governance`, `@clawboo/obs`
**External deps** `better-sqlite3`, `drizzle-orm`, `zod`, `@noble/ed25519`

<Note>
This is the registry of record. The 28 Drizzle-typed tables + the idempotent `CREATE TABLE IF NOT EXISTS` bootstrap in `ensureSchema` (`schemaBootstrap.ts`) make a fresh file immediately usable; that DDL is the **sole** schema source; there is no migration ladder (no `db:migrate` / `db:generate` scripts). Opening an older file also reconciles it, adding any columns it is missing, derived from the same DDL. SQLite-native columns (team, personality, runtime, capabilities) are never clobbered by a Gateway re-sync.
</Note>

The package exposes one barrel ([`src/index.ts`](#source)). It re-exports `schema`, `db`, and eleven domain sub-modules (`board`, `capabilities`, `memory`, `tools`, `governance`, `events`, `sessions`, `routines`, `teamChat`, `inbox`, `chat`) via `export *`. There are no `package.json` subpath `exports`; everything is reachable from `@clawboo/db`.

One of those re-exports crosses a package boundary: the board **state machine** lives in the pure, zero-dep [`@clawboo/board-core`](/reference/packages/board-core), so the browser UI and the orchestration engine can read the same transition table without pulling this package's sqlite graph. `@clawboo/db` re-exports it by name, so the symbols below are reachable from `@clawboo/db` exactly as before.

## Public API

### Functions

**Connection (`db.ts`, `schemaBootstrap.ts`, `openStats.ts`)**

| Export                 | Signature                                       | Contract                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDb`             | `(dbPath: string) => ClawbooDb`                 | `openDb` + `ensureSchema` in one call. For a process that opens one connection and exits (the MCP stdio bins, the eval harness, tests). Not for per-request use in a server.                                    |
| `openDb`               | `(dbPath: string) => ClawbooDb`                 | Open a connection and apply the WAL + contention pragmas. **No DDL** — pair with `ensureSchema`. The seam a long-lived process uses.                                                                            |
| `ensureSchema`         | `(db) => SchemaReconcileReport`                 | Reconcile an existing database up to the declared column set, then apply the bootstrap DDL. Idempotent, but not free: 89 statements re-resolved against `sqlite_master` per call. Returns the columns it added. |
| `missingSchemaColumns` | `(db) => AddedColumn[]`                         | The read-only half of the reconcile: columns the DDL declares that an existing table lacks. Empty after a successful `ensureSchema`; the boot probe uses it to verify the outcome rather than trust it.         |
| `dbOpenStats`          | `() => { connectionsOpened, schemaBootstraps }` | Monotonic process-lifetime counters. A rising `connectionsOpened` on a steady-state server is the fd-leak signal; also the shared-connection regression seam.                                                   |
| `defaultDbPath`        | `() => string`                                  | Resolve `CLAWBOO_DB_PATH` env, else `~/.openclaw/clawboo/clawboo.db`.                                                                                                                                           |
| `getSetting`           | `(db, key: string) => string \| null`           | Read one `settings` KV value.                                                                                                                                                                                   |
| `setSetting`           | `(db, key: string, value: string) => void`      | Upsert one `settings` KV value.                                                                                                                                                                                 |
| `integrityCheck`       | `(db) => string`                                | Run `PRAGMA integrity_check` and return its result string.                                                                                                                                                      |
| `listTableNames`       | `(db) => string[]`                              | List the SQLite table names present.                                                                                                                                                                            |

**Board, repository (`board/repository.ts`)**

| Export                                                                                                                | Signature                                                                  | Contract                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createTask`                                                                                                          | `(db, input: CreateTaskInput) => DbTask`                                   | Insert a kanban card.                                                                                                                                                                                                                                                                                                                                                          |
| `createSubtask`                                                                                                       | `(db, parentTaskId, input) => DbTask`                                      | Insert a child task linked by `parentTaskId`. The UNCAPPED primitive.                                                                                                                                                                                                                                                                                                          |
| `createCappedSubtask`                                                                                                 | `(db, parentTaskId, input, caps?: SubtaskCaps) => GuardedCreateResult`     | Same insert with the per-parent live-child cap (`DEFAULT_MAX_CHILDREN`, 24) and nesting-depth cap (`DEFAULT_MAX_DEPTH`, 2) enforced inside one `BEGIN IMMEDIATE` txn; returns `reason: 'parent_not_found' \| 'child_cap' \| 'depth_cap'` instead of throwing (a `GuardedCreateResult` discriminated union, so `ok: true` guarantees `task`). Backs the Tasks MCP create tools. |
| `createCappedRootTask`                                                                                                | `(db, input, caps?: RootCreateCaps) => GuardedCreateResult`                | Insert a ROOT task with a rolling-window rate cap (`DEFAULT_MAX_ROOT_CREATES`, 30 per `DEFAULT_ROOT_CREATE_WINDOW_MS`, 5 min) enforced in one txn; `reason: 'root_rate_cap'` on refusal. Backs the Tasks MCP parentless `create_task`.                                                                                                                                         |
| `getTask`                                                                                                             | `(db, taskId) => DbTask \| null`                                           | Read one task.                                                                                                                                                                                                                                                                                                                                                                 |
| `listTasks`                                                                                                           | `(db, filter?: ListTasksFilter) => DbTask[]`                               | List tasks (team/status/dropped filters).                                                                                                                                                                                                                                                                                                                                      |
| `claimTask`                                                                                                           | `(db, taskId, assigneeAgentId, assigneeRuntime?) => ClaimResult`           | Atomic single-assignee claim of a `todo` task; loser gets `{ ok:false, reason:'conflict' }` and MUST NOT retry.                                                                                                                                                                                                                                                                |
| `releaseTask`                                                                                                         | `(db, taskId) => void`                                                     | Release an `in_progress` task back to `todo`, clearing assignee + stale verdict.                                                                                                                                                                                                                                                                                               |
| `updateStatus`                                                                                                        | `(db, taskId, to, opts?: UpdateStatusOptions) => UpdateStatusResult`       | State-machine-checked transition; the intrinsic `→done` verification gate rejects a non-promotable verdict (`reason:'verification_required'`) unless `humanOverride`.                                                                                                                                                                                                          |
| `updateTaskFields`                                                                                                    | `(db, taskId, fields: TaskFields) => DbTask \| null`                       | Patch metadata fields.                                                                                                                                                                                                                                                                                                                                                         |
| `blockTask` / `unblockTask`                                                                                           | `(db, taskId) => UpdateStatusResult`                                       | Transition to/from `blocked`.                                                                                                                                                                                                                                                                                                                                                  |
| `dropTask`                                                                                                            | `(db, taskId) => void`                                                     | Soft-delete (`dropped=1`).                                                                                                                                                                                                                                                                                                                                                     |
| `linkDep`                                                                                                             | `(db, taskId, dependsOnTaskId) => void`                                    | Add a blocks/blocked-by edge (composite-PK de-duped); throws `TaskDependencyCycleError` if the edge would close a direct or transitive cycle.                                                                                                                                                                                                                                  |
| `getDependents`                                                                                                       | `(db, taskId) => DbTask[]`                                                 | Transitive downstream dependents (recursive CTE).                                                                                                                                                                                                                                                                                                                              |
| `cancelDependents`                                                                                                    | `(db, taskId) => DbTask[]`                                                 | Cancel the still-pending dependents of a failed/blocked task.                                                                                                                                                                                                                                                                                                                  |
| `getReadyTasks`                                                                                                       | `(db, filter?) => DbTask[]`                                                | Tasks with no unmet blockers (the ready-pump source).                                                                                                                                                                                                                                                                                                                          |
| `getAncestors`                                                                                                        | `(db, taskId) => AncestorRow[]`                                            | The parent chain (recursive CTE, zod-validated), backs the depth cap.                                                                                                                                                                                                                                                                                                          |
| `addComment` / `getComments`                                                                                          | comment CRUD                                                               | Per-task discussion / system notes.                                                                                                                                                                                                                                                                                                                                            |
| `createWorkspace` / `getWorkspaceForTask` / `updateWorkspaceStatus` / `listActiveWorkspaces` / `setTaskWorkspaceRefs` | worktree rows                                                              | Per-task git-worktree isolation records.                                                                                                                                                                                                                                                                                                                                       |
| `createExecutionProcess`                                                                                              | `(db, input: CreateExecInput) => DbExecutionProcess`                       | Open one run row for a task.                                                                                                                                                                                                                                                                                                                                                   |
| `completeExecutionProcess`                                                                                            | `(db, execId, outcome: CompleteExecOutcome) => DbExecutionProcess \| null` | Close a run with status + token/cost ledger, returning the updated row. Only a still-`running` exec closes: a terminal row is immutable, so a losing writer gets `null` and appends no second `execution_completed`.                                                                                                                                                           |
| `listExecutions`                                                                                                      | `(db, taskId) => DbExecutionProcess[]`                                     | Run history for a task.                                                                                                                                                                                                                                                                                                                                                        |
| `reconcileOrphans`                                                                                                    | `(db, opts?: { staleAfterMs?: number }) => ReconcileResult`                | Boot: a `running` exec whose task has stopped heartbeating (default `6 * TASK_HEARTBEAT_MS`) → `failed` + task released (tombstoned, idempotent). A still-beating run is left to its live owner.                                                                                                                                                                               |
| `reconcileStaleInProgress`                                                                                            | `(db, olderThanMs) => ReconcileResult`                                     | TTL backstop: time out + release a stale `in_progress` task.                                                                                                                                                                                                                                                                                                                   |

**Board, state machine** (re-exported from [`@clawboo/board-core`](/reference/packages/board-core))

| Export          | Signature                                       | Contract                                                                                                                              |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskStatus`    | `'backlog' \| … \| 'cancelled'`                 | The 7-status union.                                                                                                                   |
| `TASK_STATUSES` | `readonly TaskStatus[]`                         | The 7 statuses in lifecycle order (also the board's column order).                                                                    |
| `canTransition` | `(from: TaskStatus, to: TaskStatus) => boolean` | Legal-transition predicate (`done`/`cancelled` terminal). Same-status is an allowed no-op.                                            |
| `legalTargets`  | `(from: TaskStatus) => TaskStatus[]`            | Every legal target for `from`, as a fresh array. Empty for a terminal status. Lets a UI enumerate moves instead of copying the table. |
| `isLocked`      | `(status) => boolean`                           | True for `in_progress`/`in_review`.                                                                                                   |
| `isTerminal`    | `(status) => boolean`                           | True for `done`/`cancelled`.                                                                                                          |
| `isTaskStatus`  | `(value: unknown) => value is TaskStatus`       | Type guard.                                                                                                                           |

**Board, contention (`board/contention.ts`)**

| Export           | Signature                              | Contract                                         |
| ---------------- | -------------------------------------- | ------------------------------------------------ |
| `isBusyError`    | `(err: unknown) => boolean`            | True for `SQLITE_BUSY`.                          |
| `withWriteRetry` | `<T>(fn: () => T) => T`                | Jittered retry of a write on `SQLITE_BUSY` only. |
| `immediateWrite` | `<T>(db, cb: (tx: BoardTx) => T) => T` | Run `cb` inside a `BEGIN IMMEDIATE` transaction. |

**Board, verification (`board/verification.ts`)**

| Export                | Signature                                          | Contract                                           |
| --------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `setTaskVerification` | `(db, taskId, result: VerificationResult) => void` | Write the typed verdict JSON cell (zod-validated). |
| `getTaskVerification` | `(db, taskId) => VerificationResult \| null`       | Read the verdict cell.                             |

**Capabilities (`capabilities/repository.ts`)**

| Export               | Signature                                                 | Contract                                                                                                                      |
| -------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `upsertCapabilities` | `(db, sourceId, rows: DbCapabilityInsert[]) => void`      | Source-scoped reconcile in one `immediateWrite`; replaces only this source's rows (a re-read never deletes another source's). |
| `listCapabilities`   | `(db, filter?: ListCapabilitiesFilter) => DbCapability[]` | Filterable inventory read (runtime/kind/scope/agent).                                                                         |
| `getCapability`      | `(db, id) => DbCapability \| null`                        | Read one capability row.                                                                                                      |

**Memory, embedding + summary (`memory/embedding.ts`, `memory/summary.ts`)**

| Export                                        | Signature                                                    | Contract                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `cosineSimilarity`                            | `(a: number[], b: number[]) => number`                       | Cosine similarity for vector search.                                                                               |
| `serializeEmbedding` / `deserializeEmbedding` | Float32 LE BLOB ↔ `number[]`                                 | Embedding column codec.                                                                                            |
| `resolveEmbeddingProvider`                    | `(opts?: ResolveEmbeddingOpts) => EmbeddingProvider \| null` | Pick Ollama → OpenAI → deterministic, else null (FTS-only fallback).                                               |
| `buildStructuredSummary`                      | `(input: StructuredSummaryInput) => string`                  | Render the fixed compaction template (Goal/Constraints/Progress/Decisions/FilesTouched/NextSteps/CriticalContext). |

**Tools broker (`tools/*`)**

| Export                                                                                                                     | Signature                                                 | Contract                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `evaluateAvailability`                                                                                                     | `(…) => AvailabilityResult`                               | Declarative `requires` (auth/config/env/plugin) gate; a hidden tool is omitted from `tools/list`.                    |
| `defaultAvailabilityContext`                                                                                               | `(opts?: DefaultAvailabilityOpts) => AvailabilityContext` | Build the availability context.                                                                                      |
| `runInspectors`                                                                                                            | `(…) => ChainOutcome`                                     | Inspector chain (security → scope → clamp → risk) → Allow / Deny / RequireApproval / RewriteArgs.                    |
| `securityInspector` / `scopeInspector` / `argClampInspector` / `riskClassifierInspector`                                   | `Inspector`                                               | The four builtin inspectors.                                                                                         |
| `defaultInspectors`                                                                                                        | `Inspector[]`                                             | The ordered builtin chain.                                                                                           |
| `scanForInjection`                                                                                                         | `(text) => InjectionFinding[]`                            | Prompt/skill injection scanner.                                                                                      |
| `isSkillSafe`                                                                                                              | `(text) => boolean`                                       | Convenience injection check.                                                                                         |
| `signProvenance` / `verifyProvenance` / `provenancePayload`                                                                | Ed25519 provenance                                        | Sign/verify a tool descriptor; enforcement is off by default.                                                        |
| `b64urlToBytes` / `bytesToB64url`                                                                                          | base64url codec                                           | Provenance encoding helpers.                                                                                         |
| `scrubSecrets` / `scrubArgsSummary` / `scrubResultSummary`                                                                 | secret masking                                            | Storage-layer scrub (`[REDACTED]`) with a `SAFE_COUNT_KEYS` token-count allowlist.                                   |
| `executeBrokeredCall`                                                                                                      | `(…) => Promise<BrokeredResult>`                          | The one pipeline both the Tools MCP server + REST share (availability → inspectors → approval → audit → compaction). |
| `createApproval` / `getApproval` / `listPendingApprovals` / `resolveApproval` / `waitForApproval` / `expireStaleApprovals` | DB-mediated approval handshake                            | Cross-process tool-call approvals.                                                                                   |
| `writeAuditBefore` / `writeAuditAfter` / `listAudit`                                                                       | tool-call audit                                           | Before+after audit rows (scrubbed).                                                                                  |
| `seedBuiltinTools` / `setToolEnabled` / `isToolEnabled` / `persistDescriptorMetadata` / `getDescriptorMetadata`            | registry persistence                                      | Descriptor + enabled-state CRUD.                                                                                     |

**Governance (`governance/*`)**

| Export                      | Signature                                                                    | Contract                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordSpend`               | `(db, scope: BudgetScope, scopeId, deltaCents) => RecordSpendResult \| null` | Atomic micro-cent spend accumulate; returns the crossing (`cap`-mode auto-pauses at 100%, `warn`-mode never pauses); null = uncapped scope. |
| `getBudget` / `listBudgets` | budget reads                                                                 | Read budget rows.                                                                                                                           |
| `setBudgetLimit`            | `(db, input: SetBudgetLimitInput) => DbBudget`                               | Set/raise a cap (raising re-opens a paused budget).                                                                                         |
| `resumeBudget`              | `(db, …, opts?: ResumeBudgetOptions) => …`                                   | Human force-active a paused budget.                                                                                                         |
| `appendAudit`               | `(db, input: AppendAuditInput) => DbGovernanceAudit`                         | Append-only forensic audit (summary scrubbed).                                                                                              |
| `listGovernanceAudit`       | `(db, filter?: ListGovernanceAuditFilter) => …`                              | Filter audit by agent/event-type/since.                                                                                                     |
| `priorAllowAlways`          | `(db, { agentId, scopeKey }) => boolean`                                     | Sticky "always-approve per scope" lookup.                                                                                                   |

**Events (`events/*`)**

| Export        | Signature                                                   | Contract                                                                                                  |
| ------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `appendEvent` | `(db, input: AppendEventInput) => DbOrchestrationEvent`     | Append one orchestration event (`seq` SQLite-assigned, `data` scrubbed, unknown kind coerced to `error`). |
| `listEvents`  | `(db, filter?: ListEventsFilter) => DbOrchestrationEvent[]` | Read the event log in `seq` order (team/task/agent/trace/`afterSeq` filters).                             |

**Sessions, rotation lineage (`sessions/index.ts`)**

| Export                 | Signature                                                        | Contract                                                                                                        |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `recordRotation`       | `(db, input: RecordRotationInput) => { predecessor, successor }` | Upsert predecessor + insert a linked successor session in one `BEGIN IMMEDIATE` (idempotent on the unique key). |
| `getSessionBySourceId` | `(db, sourceId, sourceSessionId) => DbSession \| undefined`      | Look up a session by its source + stream key.                                                                   |
| `getSessionLineage`    | `(db, sessionId) => DbSession[]`                                 | Walk the rotation chain (newest-first).                                                                         |

**Routines, scheduled-runs ledger (`routines/*`)**

| Export                                                             | Signature                                                              | Contract                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `registerScheduledRun`                                             | `(db, input: RegisterScheduledRunInput) => RegisterScheduledRunResult` | Register a Routine with the one-firing-owner de-dup guard.    |
| `getScheduledRun` / `listScheduledRuns`                            | ledger reads                                                           | Read scheduled runs.                                          |
| `minNextRunAt`                                                     | `(db) => number \| null`                                               | Earliest `next_run_at` (arms the ticker).                     |
| `queueDueRuns` / `listQueuedRuns`                                  | due-pass                                                               | Move due `idle` runs → `queued`, then read them.              |
| `claimScheduledRun`                                                | `(db, id) => …`                                                        | Atomic `queued → claimed` (null on lost race; never retried). |
| `markRunRunning` / `recordRunOutcome` / `setScheduledRunStatus`    | lifecycle writers                                                      | Drive a fire through `running → idle`/`error`.                |
| `queueRunNow`                                                      | `(db, id) => …`                                                        | Force-fire (`idle → queued`).                                 |
| `updateScheduledRun` / `deleteScheduledRun`                        | CRUD                                                                   | Patch / remove a Routine.                                     |
| `reconcileScheduledRuns`                                           | `(db) => …`                                                            | Boot-resume: re-arm/park orphaned runs.                       |
| `canRoutineTransition` / `isAutoFireable` / `isScheduledRunStatus` | predicates                                                             | Routine state-machine helpers + type guard.                   |

**Team-chat room substrate (`teamChat/index.ts`)**

| Export               | Signature                                    | Contract                                                                                 |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `resolveRoomForTeam` | `(teamId) => string`                         | The default room id (`team:<teamId>`).                                                   |
| `postToRoom`         | `(db, input: PostToRoomInput) => DbTeamChat` | Append a post; assigns the next per-room `seq` (`MAX(seq)+1`) in a `BEGIN IMMEDIATE` tx. |
| `readRoom`           | `(db, input: ReadRoomInput) => DbTeamChat[]` | Cursor read in `seq` order; `excludeAuthorId` IS the per-poster echo guard.              |
| `roomMaxSeq`         | `(db, roomId) => number`                     | Unfiltered head `seq` of a room (0 when empty).                                          |

**Chat transcript tail (`chat/*`)**

| Export                   | Signature                                                       | Contract                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listChatMessagesSince`  | `(db, filter: ListChatMessagesSinceFilter) => DbChatMessage[]`  | Tail `chat_messages` for a set of `sessionKeys` past an `id` cursor, ascending (default limit 500). An empty key set short-circuits to `[]`. Backs the live team-chat SSE poll. |
| `listRecentChatMessages` | `(db, filter: ListRecentChatMessagesFilter) => DbChatMessage[]` | The most-recent N rows across those keys (a reverse range-seek, then reversed to oldest-first; default limit 20).                                                               |

### Types & interfaces

- **Drizzle row types** (per table, select + insert): `DbAgent`/`DbAgentInsert`, `DbApprovalHistory(+Insert)`, `DbBooZeroTeamBrief(+Insert)`, `DbBudget(+Insert)`, `DbCapability(+Insert)`, `DbChatMessage(+Insert)`, `DbCostRecord(+Insert)`, `DbExecutionProcess(+Insert)`, `DbGovernanceAudit(+Insert)`, `DbGraphLayout(+Insert)`, `DbMemoryFact(+Insert)`, `DbMemoryProcedure(+Insert)`, `DbOrchestrationEvent(+Insert)`, `DbScheduledRun(+Insert)`, `DbSession(+Insert)`, `DbSetting(+Insert)`, `DbSkill(+Insert)`, `DbTask(+Insert)`, `DbTaskComment(+Insert)`, `DbTaskDep(+Insert)`, `DbTeam(+Insert)`, `DbTeamChat(+Insert)`, `DbTeamProfile(+Insert)`, `DbToolCallApproval(+Insert)`, `DbToolCallAudit(+Insert)`, `DbToolRegistry(+Insert)`, `DbWorkspace(+Insert)`.
- **Connection**, `ClawbooDb` (the Drizzle instance type).
- **Board**, `Scope`, `CreateTaskInput`, `ListTasksFilter`, `ClaimReason`, `ClaimResult`, `UpdateStatusReason`, `UpdateStatusResult`, `UpdateStatusOptions`, `TaskFields`, `WorkspaceStatus`, `CreateExecInput`, `CompleteExecOutcome`, `ReconcileResult`, `BoardTx`, `TaskStatus`.
- **Board, guarded creation** — the types behind `createCappedSubtask` / `createCappedRootTask`:
  - `CreateGuardReason`, the refusal vocabulary: `'parent_not_found' | 'child_cap' | 'depth_cap' | 'root_rate_cap'`.
  - `GuardedCreateResult`, a **discriminated union** rather than the older `{ ok; task? }` shape: `{ ok: true; task: DbTask }` or `{ ok: false; reason: CreateGuardReason; count?: number; max?: number; windowMs?: number }`. `ok: true` guarantees `task` and `ok: false` guarantees `reason`, so no caller needs a non-null assertion. `count` is the rows already counted (`child_cap`, `root_rate_cap`), `max` the ceiling measured against, `windowMs` the rolling window (`root_rate_cap` only). A depth denial deliberately reports no observed depth — the walk clamps, so the number would be a lie.
  - `SubtaskCaps` `{ maxChildren?, maxDepth? }` and `RootCreateCaps` `{ maxRootCreates?, windowMs? }`, the per-call overrides; each field falls back to its `DEFAULT_*` constant re-exported from this package. Zod body/result types: `CreateTaskBody`, `UpdateTaskBody`, `ClaimBody`, `CommentBody`, `CreateExecutionBody`, `CompleteExecutionBody`, `LinkDepBody`, `ProvisionWorkspaceBody`, `WorkspaceActionBody`, `AncestorRow`.
- **Capabilities**, `ListCapabilitiesFilter`.
- **Memory**, `MemoryStore`, `EmbeddingProvider`, `Fact`, `Procedure`, `MemoryScope`, `MemorySearchResult`, `SearchMode`, `SearchOpts`, `BrowseOpts`, `SaveFactInput`, `SaveProcedureInput`, `ResolveEmbeddingOpts`, `StructuredSummaryInput`. Zod body types: `SaveFactBody`, `SaveProcedureBody`, `SaveMemoryBody`, `SearchMemoryBody`, `BrowseMemoryBody`, `MemoryScopeBody`.
- **Tools**, `ToolDescriptor`, `ToolCall`, `ToolCallContext`, `ToolOwner`, `ToolRisk`, `ToolProvenance`, `AvailabilityContext`, `AvailabilityRequirement`, `AvailabilityResult`, `DefaultAvailabilityOpts`, `Inspector`, `InspectorDecision`, `ChainOutcome`, `InjectionFinding`, `InjectionSeverity`, `ProvenanceResult`, `ProvenanceVerifyOpts`, `BrokeredResult`, `BrokerOptions`, `ApprovalDecision`, `ApprovalResolution`, `VisibleTool`, `ListToolsQuery`, `ResolveApprovalBody`.
- **Governance**, `BudgetScope`, `BudgetMode`, `RecordSpendResult`, `SetBudgetLimitInput`, `ResumeBudgetOptions`, `GovernanceEventType`, `AppendAuditInput`, `ListGovernanceAuditFilter`, `SetBudgetBody`.
- **Events**, `AppendEventInput`, `ListEventsFilter`.
- **Sessions**, `RecordRotationInput`.
- **Routines**, `ScheduledRunStatus`, `RegisterScheduledRunInput`, `RegisterScheduledRunResult`, `ListScheduledRunsFilter`, `RoutineScope`, `RunOutcome`, `SetStatusResult`, `UpdateScheduledRunPatch`.
- **Team-chat**, `TeamChatKind`, `PostToRoomInput`, `ReadRoomInput`.
- **Chat transcript tail**, `ListChatMessagesSinceFilter`, `ListRecentChatMessagesFilter`.

### Classes

- `TaskDependencyCycleError`, thrown by `linkDep` when an edge would close a direct or transitive dependency cycle. Carries `code: 'task_dependency_cycle'`; the `link_task` MCP tool maps it to a tool-error.
- `SqliteMemoryStore`, the local-first `MemoryStore` (FTS5 + optional Float32-BLOB vector index + hybrid blend; embedding best-effort, degrades to FTS).
- `DeterministicEmbeddingProvider` / `OllamaEmbeddingProvider` / `OpenAiEmbeddingProvider`, the three `EmbeddingProvider` implementations.
- `ToolRegistry`, in-memory broker tool registry; `createBuiltinRegistry()` seeds it.

### Constants

- **Schema**, the 27 Drizzle table objects the barrel re-exports: `agents`, `approvalHistory`, `booZeroTeamBriefs`, `budgets`, `capabilities`, `chatMessages`, `costRecords`, `executionProcesses`, `governanceAudit`, `graphLayouts`, `memoryFacts`, `memoryProcedures`, `orchestrationEvents`, `scheduledRuns`, `sessions`, `settings`, `skills`, `taskComments`, `taskDeps`, `tasks`, `teamChat`, `teams`, `teamProfiles`, `toolCallApprovals`, `toolCallAudit`, `toolRegistry`, `workspaces`. The 28th table, `agent_inbox`, is declared in `schema.ts` but its table object is not re-exported; reach its rows through the `inbox` accessors instead.
- **Board**, `TASK_STATUSES`, plus the zod schemas `taskStatusSchema`, `createTaskBody`, `updateTaskBody`, `claimBody`, `commentBody`, `createExecutionBody`, `completeExecutionBody`, `linkDepBody`, `provisionWorkspaceBody`, `workspaceActionBody`, `ancestorRowSchema`, `ancestorRowsSchema`.
- **Memory**, zod schemas `memoryScopeSchema`, `searchModeSchema`, `saveFactBody`, `saveProcedureBody`, `saveMemoryBody`, `searchMemoryBody`, `browseMemoryBody`.
- **Tools**, `BUILTIN_TOOLS`, `echoTool`, `memoryNoteTool`, `webSearchTool`, `deletePathTool`; zod schemas `listToolsQuery`, `resolveApprovalBody`.
- **Governance**, zod schemas `budgetScopeSchema`, `budgetModeSchema`, `setBudgetBody`, `resumeBudgetBody`.
- **Routines**, `SCHEDULED_RUN_STATUSES`.

## Used by

- **`apps/web`**, the Express server (`server/`, `server/api/`, `server/lib/**`) and three browser sites (`src/stores`, `src/features/approvals`, `src/features/connection`) — all three **type-only**, since a value import would drag the sqlite graph into the SPA. The board UI reads its status rules from `@clawboo/board-core` directly for the same reason.
- **`@clawboo/mcp`**, the Tasks / Memory / Tools / TeamChat MCP servers + the stdio bins.
- **`@clawboo/evals`**, the eval harness graders/tasks (throwaway boards).

## Source

Barrel: [`packages/db/src/index.ts`](https://github.com/clawboo/clawboo/blob/main/packages/db/src/index.ts). Schema: `packages/db/src/schema.ts`. Sub-modules: `board/`, `capabilities/`, `memory/`, `tools/`, `governance/`, `events/`, `sessions/`, `routines/`, `teamChat/`, `inbox.ts`, `chat/`. Connection: `db.ts`. Schema bootstrap DDL: `schemaBootstrap.ts` (the sole schema source; there is no migration ladder). Additive in-place upgrade: `schemaReconcile.ts`. Open-counters: `openStats.ts`.

## See also

- [Database schema reference](/reference/database-schema), the 28 tables + ERD.
- [The board](/concepts/the-board), state machine, atomic claim, deps.
- [Memory](/concepts/memory), shared Memory-MCP tier.
- [Governance](/concepts/governance), budgets, kill-switch, audit.
- [Observability](/concepts/observability), the event log.
- [`@clawboo/governance`](/reference/packages/governance) · [`@clawboo/obs`](/reference/packages/obs) · [`@clawboo/mcp`](/reference/packages/mcp), consumers/upstreams of this layer.
