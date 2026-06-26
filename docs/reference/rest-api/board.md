---
title: Board API
description: 'REST reference for the durable board: tasks, atomic claim, status gate, comments, executions, deps, and per-task worktrees.'
---

REST surface over the durable [board](/concepts/the-board), the transactional source of truth for team/task coordination. These routes create and list tasks, atomically claim a task for a single assignee, transition status through the state machine (with the intrinsic verification gate), record the execution ledger, link dependency chains, cancel a dead downstream chain, and provision / inspect / pause / complete a task's per-task git worktree (its system-of-record).

The board is a thin HTTP layer over `@clawboo/db`'s board repository, the data boundary. Every POST/PATCH body is validated by a co-located zod schema; an invalid body returns **400** `{ error: 'invalid body', details: <zod flatten> }`. The worktree-handoff route validates against `@clawboo/worktrees`' handoff schema and returns **400** `{ error: 'invalid handoff', details: <zod flatten> }` instead. All bodies are parsed by `express.json({ limit: '2mb' })`.

<Info>
The atomic claim is the board's concurrency primitive. `POST /api/board/:taskId/claim` returns **409** when another worker already won. Per the board contract, **a 409 is data, not a transient error; do not retry it.** The loser did not lose a race it can re-run; the task is simply taken. The same rule applies to the `409 illegal_transition` on `PATCH /api/board/:taskId`.
</Info>

## Routes

| Method | Path                                   | Summary                                                     | Stream? |
| ------ | -------------------------------------- | ----------------------------------------------------------- | ------- |
| GET    | `/api/board`                           | List tasks (or ready-to-work tasks) for a team              | No      |
| POST   | `/api/board`                           | Create a task                                               | No      |
| GET    | `/api/board/:taskId`                   | One task + its comments + ancestor chain                    | No      |
| POST   | `/api/board/:taskId/claim`             | Atomically claim a `todo` task (409 contract)               | No      |
| PATCH  | `/api/board/:taskId`                   | Transition status (verification-gated) and/or edit metadata | No      |
| POST   | `/api/board/:taskId/comments`          | Add a comment                                               | No      |
| GET    | `/api/board/:taskId/executions`        | The run ledger for a task                                   | No      |
| POST   | `/api/board/:taskId/executions`        | Open an execution row (after a claim)                       | No      |
| PATCH  | `/api/board/executions/:execId`        | Close an execution with its outcome + ledger                | No      |
| POST   | `/api/board/:taskId/deps`              | Link a dependency (plan / blocked-by)                       | No      |
| POST   | `/api/board/:taskId/cancel-dependents` | Cancel the dead downstream chain of a failed task           | No      |
| POST   | `/api/board/:taskId/workspace`         | Provision a worktree + branch + SoR scaffold                | No      |
| GET    | `/api/board/:taskId/workspace`         | Cold-resume read: workspace + reconstructed state           | No      |
| PATCH  | `/api/board/:taskId/workspace`         | `pause` or `complete` the worktree                          | No      |
| POST   | `/api/board/:taskId/workspace/handoff` | Write the clock-out `AGENT_HANDOFF.json`                    | No      |
| GET    | `/api/board/:taskId/workspace/detail`  | SoR file contents + unified diff (drawer view)              | No      |

<Note>
The worktree routes share a `:taskId` prefix; the router registers the longer two-segment paths (`/workspace/handoff`, `/workspace/detail`) before the bare `/workspace`, and the execution paths (`/executions`, `/executions/:execId`) are distinct two-segment forms, so there is no path collision with `/:taskId`.
</Note>

The 7 task statuses are `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`. `done` and `cancelled` are terminal. The legal forward transitions are fixed by the state machine; an illegal transition is rejected with **409** `illegal_transition`.

---

## `GET /api/board`

Lists tasks for a team, or the subset that is ready to work. With `ready=true` the response is `getReadyTasks` (status `todo`, not dropped, with every dependency `done`); otherwise it is `listTasks` filtered by `teamId` / `status` / `includeDropped`. Dropped (soft-deleted) tasks are excluded unless `includeDropped=true`.

- **Query params**:

| Param            | Type        | Notes                                                                                  |
| ---------------- | ----------- | -------------------------------------------------------------------------------------- |
| `teamId`         | string      | Scope to one team. Omit for all teams.                                                 |
| `status`         | task status | Filter by one status (one of the 7). Ignored when `ready=true`.                        |
| `ready`          | `'true'`    | Return only ready-to-work tasks (deps satisfied). Overrides `status`/`includeDropped`. |
| `includeDropped` | `'true'`    | Include soft-deleted tasks.                                                            |

- **Request body**: none.

### Responses

**`200 OK`**: the task list (`tasks[]` is `DbTask[]`, newest-`updatedAt` first; the `ready` variant orders by `priority` then `updatedAt`):

```ts
{
  tasks: Array<{
    id: string
    title: string
    description: string | null
    status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
    priority: number
    teamId: string | null
    assigneeAgentId: string | null
    assigneeRuntime: string | null
    parentTaskId: string | null
    sourceDelegationId: string | null
    worktreeRef: string | null
    branchRef: string | null
    costUsd: number
    parentSessionId: string | null
    dropped: number // 0 | 1 (soft-delete flag)
    tenantId: string | null // dormant multi-tenant seam
    scheduledBy: string // 'manual' | 'clawboo' | runtime id
    verification: string | null // typed VerificationResult JSON, null until a gate runs
    createdAt: number
    updatedAt: number
    completedAt: number | null
  }>
}
```

**`500 Internal Server Error`**: any DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
# Ready-to-work tasks for a team
curl 'http://localhost:18790/api/board?teamId=<team-id>&ready=true'

# All in-progress tasks for a team
curl 'http://localhost:18790/api/board?teamId=<team-id>&status=in_progress'
```

---

## `POST /api/board`

Creates a task. `status` defaults to `todo` (immediately claimable); pass `backlog` for triage. A subtask is created by setting `parentTaskId` (the parent chain bounds delegation depth). On success the handler emits a `task_created` observability event (a no-op when obs is off).

- **Path/query params**: none.
- **Request body** (validated by `createTaskBody`):

```ts
{
  title: string                 // required, 1–500 chars
  description?: string          // ≤ 20000 chars
  status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
  priority?: number             // integer
  teamId?: string               // non-empty if present (no '' scope-escape)
  assigneeRuntime?: string
  parentTaskId?: string
  sourceDelegationId?: string
  tenantId?: string             // non-empty if present
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`200 OK`**: the created task (full `DbTask`, shape as in `GET /api/board`):

```ts
{ task: { id: string, title: string, status: 'todo', /* …full DbTask… */ } }
```

**`500 Internal Server Error`**: DB failure:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board \
  -H 'Content-Type: application/json' \
  -d '{"title":"Implement /api/foo","teamId":"<team-id>","priority":1}'
```

---

## `GET /api/board/:taskId`

Returns one task plus its comments (oldest first) and its ancestor chain (the parent-task lineage, via recursive CTE).

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`200 OK`**:

```ts
{
  task: DbTask // shape as in GET /api/board
  comments: Array<{
    id: string
    taskId: string
    authorAgentId: string | null
    authorType: 'agent' | 'user' | 'system'
    body: string
    tenantId: string | null
    createdAt: number
  }>
  ancestors: Array<{
    id: string
    parent_task_id: string | null
    title: string
    status: string
  }>
}
```

**`404 Not Found`**: no such task:

```json
{ "error": "task not found" }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/board/<task-id>
```

---

## `POST /api/board/:taskId/claim`

Atomically claims a `todo` task for a single assignee. The claim is a guarded UPDATE (`status='todo' AND assignee IS NULL AND dropped=0`); at most one caller wins, the task flips to `in_progress`, and the loser gets a **409**. On a win the handler emits a `task_claimed` event and narrates the claim into the team chat room (best-effort, after the canonical write, never a write path back).

<Danger>
A **409** means another worker holds the task. Do **not** retry it. A dead `in_progress` task is recovered by orphan reconciliation (which releases it to `todo`), after which a normal claim re-acquires it; the liveness logic lives there, not in the claim.
</Danger>

- **Path params**: `taskId`.
- **Request body** (validated by `claimBody`):

```ts
{
  assigneeAgentId: string       // required, non-empty
  assigneeRuntime?: string      // e.g. 'claude-code', 'clawboo-native'
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`200 OK`**: the claim won; the task is now `in_progress` and assigned:

```ts
{ ok: true, task: DbTask }
```

**`404 Not Found`**: the task does not exist (`reason: 'not_found'`):

```json
{ "ok": false, "error": "not_found" }
```

**`409 Conflict`**: the task was not in a claimable state (already claimed, dropped, or not `todo`):

```json
{ "ok": false, "error": "conflict" }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/claim \
  -H 'Content-Type: application/json' \
  -d '{"assigneeAgentId":"native-leader-abc","assigneeRuntime":"clawboo-native"}'
```

---

## `PATCH /api/board/:taskId`

Transitions a task's status and/or edits its metadata (`priority` / `title` / `description`). At least one field is required. The status change is enforced by the state machine inside a `BEGIN IMMEDIATE` transaction (illegal transition → **409**). When the target is `done`, the **intrinsic verification gate** applies: a task carrying a non-promotable verdict (a failing deterministic gate, including red-gate debt) is rejected with **409** `verification_required`. The only bypass is `humanOverride: true`; when used with `status: 'done'` the override is recorded in the governance audit log so it is never silent.

<Note>
A task with **no** stored verification verdict is *unverified*, not *failing*; it lands `done` normally. The gate blocks known-failing verdicts, not un-run verification; manually completing unverified work is an intentional human judgment call (the autonomous path always writes a verdict via the verification gate before this transition). Moving a task to `todo` releases it (clears the assignee + verdict) so the atomic claim can re-acquire it.
</Note>

On a successful status change the handler emits a `status_changed` event and narrates the mutation into the team chat room (best-effort, after the canonical write).

- **Path params**: `taskId`.
- **Request body** (validated by `updateTaskBody`; at least one field required):

```ts
{
  status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
  priority?: number             // integer
  title?: string                // 1–500 chars
  description?: string          // ≤ 20000 chars
  humanOverride?: boolean        // audited bypass of the →done gate; only with status:'done'
}
```

### Responses

**`400 Bad Request`**: empty body or failed validation:

```json
{
  "error": "invalid body",
  "details": { "formErrors": ["at least one field required"], "fieldErrors": {} }
}
```

**`200 OK`**: applied; the updated task:

```ts
{ ok: true, task: DbTask }
```

**`404 Not Found`**: the task does not exist (`reason: 'not_found'`, or the field update found no row):

```json
{ "ok": false, "error": "not_found" }
```

(or, when only fields were edited and the row vanished:)

```json
{ "error": "task not found" }
```

**`409 Conflict`**: the status transition is illegal or the verification gate blocked `→done`:

```ts
{ ok: false, error: 'illegal_transition' | 'verification_required' }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
# Bump priority + retitle
curl -X PATCH http://localhost:18790/api/board/<task-id> \
  -H 'Content-Type: application/json' \
  -d '{"priority":5,"title":"Updated title"}'

# Ship despite a non-promotable verdict (audited)
curl -X PATCH http://localhost:18790/api/board/<task-id> \
  -H 'Content-Type: application/json' \
  -d '{"status":"done","humanOverride":true}'
```

---

## `POST /api/board/:taskId/comments`

Adds a comment to a task (discussion or a system note). `authorType` defaults to `agent`. The handler emits a `comment_added` event and narrates a truncated form of the comment into the team chat room (best-effort, after the write). The handler does not 404 a missing task before inserting; the comment row is created against the supplied `taskId`.

- **Path params**: `taskId`.
- **Request body** (validated by `commentBody`):

```ts
{
  body: string                          // required, 1–20000 chars
  authorAgentId?: string
  authorType?: 'agent' | 'user' | 'system'   // default 'agent'
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`200 OK`**: the created comment:

```ts
{
  ok: true
  comment: {
    id: string
    taskId: string
    authorAgentId: string | null
    authorType: 'agent' | 'user' | 'system'
    body: string
    tenantId: string | null
    createdAt: number
  }
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Blocked on the upstream schema.","authorType":"agent","authorAgentId":"native-leader-abc"}'
```

---

## `POST /api/board/:taskId/executions`

Opens an execution-process row for a task, recorded only after a successful claim. The exec ledger is what orphan reconciliation reads on restart: an executor that starts work MUST open one here and close it via the PATCH below, or a crash leaves the run orphaned (reconciliation then marks it `failed` and releases the task). On success the handler emits an `execution_started` event.

- **Path params**: `taskId`.
- **Request body** (validated by `createExecutionBody`):

```ts
{
  executorType: string          // required, 1–100 chars (the runtime id)
  workspaceId?: string
  runReason?: string            // ≤ 2000 chars
  beforeCommit?: string         // ≤ 200 chars (git checkpoint)
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`404 Not Found`**: the task does not exist:

```json
{ "error": "task not found" }
```

**`200 OK`**: the created execution row (starts in `status: 'running'`):

```ts
{
  ok: true
  execution: {
    id: string
    taskId: string
    workspaceId: string | null
    executorType: string
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
    claimedAt: number | null
    startedAt: number | null
    completedAt: number | null
    beforeCommit: string | null
    afterCommit: string | null
    inputTokens: number | null
    outputTokens: number | null
    cacheRead: number | null
    cacheWrite: number | null
    costUsd: number | null
    summary: string | null
    runReason: string | null
    error: string | null
    recoveryTombstone: number // 0 | 1
    tenantId: string | null
    createdAt: number
  }
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/executions \
  -H 'Content-Type: application/json' \
  -d '{"executorType":"claude-code","beforeCommit":"<sha>"}'
```

---

## `PATCH /api/board/executions/:execId`

Closes out an execution row with its outcome and an optional token/cost ledger. The handler emits an `execution_completed` event; `taskId`/`agentId` are not in scope on this REST path (only `execId`), so correlate via the `execution_started` event by `execId`.

- **Path params**: `execId`.
- **Request body** (validated by `completeExecutionBody`):

```ts
{
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'   // required
  summary?: string              // ≤ 20000 chars
  error?: string                // ≤ 20000 chars
  afterCommit?: string          // ≤ 200 chars
  inputTokens?: number          // integer
  outputTokens?: number         // integer
  cacheRead?: number            // integer
  cacheWrite?: number           // integer
  costUsd?: number
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`200 OK`**: the execution was closed:

```json
{ "ok": true }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X PATCH http://localhost:18790/api/board/executions/<exec-id> \
  -H 'Content-Type: application/json' \
  -d '{"status":"succeeded","inputTokens":1200,"outputTokens":340,"costUsd":0.012}'
```

---

## `GET /api/board/:taskId/executions`

Lists a task's execution-process rows (the run ledger), every spawned run, oldest first.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`200 OK`**: the ledger (`executions[]` is `DbExecutionProcess[]`, shape as in `POST .../executions`):

```ts
{ ok: true, executions: DbExecutionProcess[] }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/board/<task-id>/executions
```

---

## `POST /api/board/:taskId/deps`

Links a dependency: `taskId` will not become ready until `dependsOnTaskId` is `done`. Plans become a dep chain; the orchestrator's ready-pump fires the next step when its blocker completes. Both endpoints of the edge must exist (the handler guards against orphan dep rows). On success the handler emits a `dep_linked` event and narrates the dependency into the team chat room.

- **Path params**: `taskId` (the dependent).
- **Request body** (validated by `linkDepBody`):

```ts
{
  dependsOnTaskId: string // required, non-empty (the blocker)
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`404 Not Found`**: either the task or the blocker does not exist:

```json
{ "error": "task not found" }
```

**`200 OK`**: the edge was linked (duplicate edges are ignored):

```json
{ "ok": true }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board/<step-2-id>/deps \
  -H 'Content-Type: application/json' \
  -d '{"dependsOnTaskId":"<step-1-id>"}'
```

---

## `POST /api/board/:taskId/cancel-dependents`

Cancels the still-pending (`todo`/`backlog`) transitive dependents of a failed task. A `blocked`/failed blocker can never become `done`, so its downstream chain is dead; cancelling it surfaces the stall instead of leaving ghost `todo` cards that can never become ready. Dependents already `in_progress`/`done`/`cancelled` are left untouched. Each cancelled task emits a `status_changed` event with `reason: 'blocker_failed'`. The returned list lets the caller report the stalled plan chain to the leader.

- **Path params**: `taskId` (the failed blocker).
- **Request body**: none.

### Responses

**`404 Not Found`**: the task does not exist:

```json
{ "error": "task not found" }
```

**`200 OK`**: the cancelled dependents (id + title only; may be an empty array):

```ts
{
  cancelled: Array<{ id: string; title: string }>
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board/<failed-task-id>/cancel-dependents
```

---

## `POST /api/board/:taskId/workspace`

Provisions a git worktree + branch + system-of-record (SoR) scaffold for a file-mutating task, and records the worktree/branch refs on the task. The worktree lives outside the user's repo (under the clawboo state dir, namespaced by a hash of the repo path) so it never pollutes the repo's own `git status`. Isolation is decided by task `kind`: `code` (and unknown kinds) → `worktree`; `research` / `review` → `none` (refused). A repeated provision for a task that already has a live, registered checkout reuses it rather than inserting a duplicate workspace row.

<Note>
A read-only / research task is refused with **422**; it has no file mutations to isolate, so it should not pay the worktree cost.
</Note>

- **Path params**: `taskId`.
- **Request body** (validated by `provisionWorkspaceBody`):

```ts
{
  repoPath: string              // required, 1–4000 chars — the git repo to branch from
  baseSha?: string              // ≤ 200 chars — pins the branch point
  baseRef?: string              // ≤ 400 chars — branch point (default HEAD) when no baseSha
  kind?: string                 // ≤ 100 chars — task kind → isolation; defaults to 'code'
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`404 Not Found`**: the task does not exist (`reason: 'not_found'`):

```json
{ "ok": false, "error": "task not found" }
```

**`422 Unprocessable Entity`**: the task kind resolves to no worktree isolation (research/review):

```ts
{ ok: false, error: 'no_isolation', isolation: 'none' | 'container' }
```

**`200 OK`**: the worktree was provisioned (or an existing one reused):

```ts
{
  ok: true
  worktree: {
    taskId: string
    worktreePath: string // absolute path to the checkout
    branch: string // 'clawboo/task-<id>'
    baseCommit: string // the SoR-scaffold baseline commit
    detached: boolean // false for a task worktree
  }
  workspaceId: string
  isolation: 'worktree'
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/workspace \
  -H 'Content-Type: application/json' \
  -d '{"repoPath":"/path/to/repo","kind":"code"}'
```

---

## `GET /api/board/:taskId/workspace`

The cold-resume read: the task's workspace row plus the resume state reconstructed purely from the worktree's system-of-record (`AGENT_HANDOFF.json`, falling back to `task-progress.md` + `init.sh`), no chat history, no board UI. This is what lets a fresh runtime (or a human) pick up a task from the worktree alone.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`404 Not Found`**: no workspace row for the task (or it has no recorded worktree path):

```json
{ "error": "workspace not found" }
```

**`200 OK`**: the workspace, the reconstructed resume state, and the parsed handoff (each may be `null` when the worktree is paused-away or no handoff was written):

```ts
{
  ok: true
  workspace: {
    id: string
    taskId: string
    repoPath: string
    branch: string | null
    worktreePath: string | null
    status: 'active' | 'archived' | 'stale'
    tenantId: string | null
    createdAt: number
    lastUsedAt: number | null
  }
  resume: {
    hasHandoff: boolean
    done: string[]                // completed subtasks
    broken: string[]              // broken / unverified items
    next: string | null           // the single next best step
    whyBlocked?: string | null
    commands: { init: string; verify: string; start: string }
    warnings: string[]
    lastRuntime?: string | null   // who wrote the last handoff (may be 'human')
    nativeSessionId?: string | null
  } | null
  handoff: AgentHandoff | null    // the parsed AGENT_HANDOFF.json (shape below)
}
```

### Example

```bash
curl http://localhost:18790/api/board/<task-id>/workspace
```

---

## `PATCH /api/board/:taskId/workspace`

Pauses or completes a task's worktree.

- **`pause`**: commit any uncommitted work, drop the worktree, keep the branch (the workspace stays `active` and resumable).
- **`complete`**: an empty diff cleans up the worktree + branch and drives the task to `done` (an empty diff has no deliverable, so the verification gate is intentionally bypassed). A non-empty diff lands the task in `in_review`, runs the verification gate, then gates `→done`: a `pass` (or a `completed_with_debt` over a green deterministic gate) promotes to `done`; debt over a red deterministic gate routes to `blocked` (with a system comment); a `fail` reverts to `in_progress`. SoR bookkeeping files are excluded from the diff (a session that only wrote its own progress/handoff is still "empty").

- **Path params**: `taskId`.
- **Request body** (validated by `workspaceActionBody`):

```ts
{
  action: 'pause' | 'complete' // required
}
```

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`404 Not Found`**: no workspace row (or it has no worktree path / branch):

```json
{ "ok": false, "error": "workspace not found" }
```

**`200 OK` (`pause`)**: committed-or-not + the resulting HEAD sha:

```ts
{ ok: true, action: 'pause', pause: { committed: boolean, head: string } }
```

**`200 OK` (`complete`)**: the diff outcome, the resulting task status, and (when the gate ran on a dirty diff) the verification verdict:

```ts
{
  ok: true
  action: 'complete'
  complete: {
    dirty: boolean              // any change vs baseline
    diffStat: { filesChanged: number, insertions: number, deletions: number, dirty: boolean }
    cleaned: boolean            // empty-diff worktree auto-removed
  }
  taskStatus: string            // 'done' | 'in_review' | 'in_progress' | 'blocked' | …
  verified?: 'pass' | 'fail' | 'completed_with_debt'   // present only on a dirty-diff complete
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
# Pause (resumable)
curl -X PATCH http://localhost:18790/api/board/<task-id>/workspace \
  -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'

# Complete (runs the verification gate on a dirty diff)
curl -X PATCH http://localhost:18790/api/board/<task-id>/workspace \
  -H 'Content-Type: application/json' \
  -d '{"action":"complete"}'
```

---

## `POST /api/board/:taskId/workspace/handoff`

Writes the clock-out `AGENT_HANDOFF.json` into the task's worktree, structured data, not prose, so a different runtime (or a human) can pick up the task cleanly. `timestamp` is defaulted server-side to the current ISO-8601 time when omitted before validation.

- **Path params**: `taskId`.
- **Request body** (validated by `agentHandoffSchema`; `timestamp` defaulted server-side):

```ts
{
  handoffFrom: string                 // required, non-empty — who is handing off
  runtime: string                     // required, non-empty — the producing runtime (may be 'human')
  timestamp?: string                  // ISO-8601; defaulted server-side when omitted
  completedSubtasks?: string[]        // default []
  brokenOrUnverified?: string[]       // default []
  nextBestStep?: string               // default ''
  whyBlocked?: string | null
  commands?: { init?: string; verify?: string; start?: string }  // defaults: init './init.sh', verify '', start ''
  evidence?: { testResults?: string | null; lintResults?: string | null }
  warnings?: string[]                 // default []
  nativeSessionId?: string | null     // same-runtime resume handle
  roomCursor?: { roomId: string; lastSeenSeq: number } | null
}
```

### Responses

**`400 Bad Request`**: the handoff failed validation:

```json
{ "error": "invalid handoff", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`404 Not Found`**: no workspace row (or it has no worktree path):

```json
{ "ok": false, "error": "workspace not found" }
```

**`200 OK`**: the handoff was written:

```json
{ "ok": true }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/workspace/handoff \
  -H 'Content-Type: application/json' \
  -d '{
    "handoffFrom":"native-specialist-abc",
    "runtime":"clawboo-native",
    "completedSubtasks":["wired the route"],
    "brokenOrUnverified":["the e2e test is flaky"],
    "nextBestStep":"stabilize the flaky test"
  }'
```

---

## `GET /api/board/:taskId/workspace/detail`

The task-detail drawer's Workspace tab: the SoR file contents (`TASK.md`, `task-progress.md`, `DECISIONS.json`, `init.sh`, `VERIFICATION.md`, `AGENT_HANDOFF.json`, only those present) plus the unified diff and diff-stat against the branch-point baseline, with the SoR bookkeeping files excluded.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`404 Not Found`**: no workspace row (or it has no worktree path):

```json
{ "error": "workspace not found" }
```

**`200 OK`**: the SoR contents + diff (`diffStat` / `diff` may be empty when the worktree is paused-away or git is unavailable):

```ts
{
  ok: true
  workspace: DbWorkspace        // shape as in GET .../workspace
  sorFiles: Record<string, string>   // keyed by SoR filename
  diffStat: { filesChanged: number, insertions: number, deletions: number, dirty: boolean } | null
  diff: string                  // unified diff (SoR bookkeeping excluded), '' when unavailable
}
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
curl http://localhost:18790/api/board/<task-id>/workspace/detail
```

---

## Error envelope

Every error response on these routes is the standard envelope `{ error: string }`, except:

- Body-validation 400s, which add `details` (the zod `flatten()` output): `{ error: 'invalid body', details: {...} }` (or `{ error: 'invalid handoff', details: {...} }` on the handoff route).
- The `claim` route's failure paths and the `PATCH /:taskId` status-failure paths, which return `{ ok: false, error: <reason> }` (`reason` ∈ `not_found` | `conflict` | `illegal_transition` | `verification_required`).
- The `provision` route's failure paths, which return `{ ok: false, error: 'task not found' }` (404) or `{ ok: false, error: 'no_isolation', isolation }` (422).
- The `workspace` action / handoff 404s, which return `{ ok: false, error: 'workspace not found' }` (the cold-resume GET and the detail GET use the bare `{ error: 'workspace not found' }`).

## See also

- [The board](/concepts/the-board), the state machine, atomic claim, dep chains, and orphan reconciliation
- [Worktrees and handoff](/concepts/worktrees-and-handoff), the per-task system-of-record + cross-runtime `AGENT_HANDOFF.json`
- [Verification](/concepts/verification), builder≠judge, the deterministic gate + critic, `completed_with_debt`
- [Runtimes API](/reference/rest-api/runtimes), `POST /api/runtimes/:id/run` claims and drives one of these tasks end to end
- [Database schema](/reference/database-schema), the `tasks`, `task_deps`, `task_comments`, `workspaces`, `execution_processes` tables
- [REST API overview](/reference/rest-api/index)
