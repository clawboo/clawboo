---
title: 'Board API'
sidebarTitle: 'Board'
description: 'REST reference for the board: tasks, claims, status changes, comments, retry, assign, the run ledger, dependencies, worktrees, workspace files and preview.'
keywords: ['board', 'tasks', 'kanban', 'claim', 'worktree', 'workspace', 'preview', 'executions']
---

These routes read and change the [board](/concepts/the-board), where every team's tasks live. They create and list tasks, claim a task for one agent, move tasks through the status rules (including the check that guards `done`), record each run in the run ledger, link dependencies, and manage a task's git worktree: create it, read it, pause or complete it, browse its files and preview what the agent built.

Several routes also post a short system line to the team's peer room, the agents' shared room behind the TeamChat tools (see [Peer chat](/concepts/peer-chat)). The dashboard's team chat does not show those lines, and a failed post never fails the request.

Every POST and PATCH body is validated. An invalid body returns **400** `{ "error": "invalid body", "details": <zod flatten> }`; the handoff route returns `{ "error": "invalid handoff", "details": ... }` instead. Every route here is on the general rate tier (see [rate limits](/reference/rest-api/index#rate-limits)).

<Info>

A claim is how agents share work without doing it twice: `POST /api/board/:taskId/claim` answers **409** when another worker already holds the task. **A 409 is an answer, not a transient error; do not retry it.** The task is simply taken. The same applies to `409 illegal_transition` on `PATCH /api/board/:taskId`.

</Info>

## Routes

| Method | Path                                     | Summary                                                       | Stream? |
| ------ | ---------------------------------------- | ------------------------------------------------------------- | ------- |
| GET    | `/api/board`                             | List tasks (or the ready-to-work ones)                        | No      |
| POST   | `/api/board`                             | Create a task (optionally for one agent, started at once)     | No      |
| POST   | `/api/board/:taskId/retry`               | Run a stuck task again, straight to its agent                 | No      |
| POST   | `/api/board/:taskId/assign`              | Give an unowned task to one team member and start it          | No      |
| GET    | `/api/board/:taskId`                     | One task with its comments and parent chain                   | No      |
| POST   | `/api/board/:taskId/claim`               | Claim a `todo` task for one agent (409 if taken)              | No      |
| PATCH  | `/api/board/:taskId`                     | Change status (checked) and edit title, description, priority | No      |
| POST   | `/api/board/:taskId/comments`            | Add a comment (a person's reply reaches the task's agent)     | No      |
| POST   | `/api/board/:taskId/executions`          | Open a run in the ledger (after a claim)                      | No      |
| PATCH  | `/api/board/executions/:execId`          | Close a run with its outcome, tokens and cost                 | No      |
| GET    | `/api/board/:taskId/executions`          | The task's run ledger                                         | No      |
| POST   | `/api/board/:taskId/deps`                | Make one task wait for another                                | No      |
| POST   | `/api/board/:taskId/cancel-dependents`   | Cancel the waiting tasks behind a failed one                  | No      |
| POST   | `/api/board/:taskId/workspace`           | Create the task's worktree, branch and task files             | No      |
| GET    | `/api/board/:taskId/workspace`           | Read the workspace and the state to resume from               | No      |
| PATCH  | `/api/board/:taskId/workspace`           | `pause` or `complete` the worktree                            | No      |
| POST   | `/api/board/:taskId/workspace/handoff`   | Write `AGENT_HANDOFF.json` for the next runtime or person     | No      |
| GET    | `/api/board/:taskId/workspace/detail`    | Task file contents and the diff (the task drawer view)        | No      |
| GET    | `/api/board/:taskId/workspace/tree`      | One directory level of the worktree                           | No      |
| GET    | `/api/board/:taskId/workspace/file`      | One file, size-capped                                         | No      |
| GET    | `/api/board/:taskId/workspace/file-diff` | One file's diff against the starting commit                   | No      |
| GET    | `/api/board/:taskId/workspace/status`    | `git status` for the worktree                                 | No      |
| GET    | `/api/board/:taskId/preview`             | Serve the worktree's `index.html` (redirects to `preview/`)   | No      |
| GET    | `/api/board/:taskId/preview/<path>`      | Serve one file from the worktree, for the preview frame       | No      |

## Task statuses

A task is in one of seven statuses: `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`. `done` and `cancelled` are final. Writing the status a task already has is allowed and changes nothing. Any move not in this table is refused with **409** `illegal_transition`:

| From                | Can move to                                         |
| ------------------- | --------------------------------------------------- |
| `backlog`           | `todo`, `blocked`, `cancelled`                      |
| `todo`              | `in_progress`, `blocked`, `backlog`, `cancelled`    |
| `in_progress`       | `in_review`, `done`, `blocked`, `todo`, `cancelled` |
| `in_review`         | `done`, `in_progress`, `blocked`, `cancelled`       |
| `blocked`           | `todo`, `in_progress`, `backlog`, `cancelled`       |
| `done`, `cancelled` | nothing                                             |

Moving a task to `todo` clears its assignee and its check result, so it can be claimed again.

---

## `GET /api/board`

Lists tasks, for one team or all of them, or only the tasks that are ready to work. With `ready=true` the list holds `todo` tasks that are not dropped and whose dependencies are all `done`. Otherwise it is filtered by `teamId`, `status` and `includeDropped`. Dropped (soft-deleted) tasks are left out unless `includeDropped=true`.

- **Query params**:

| Param            | Type        | Notes                                                                                  |
| ---------------- | ----------- | -------------------------------------------------------------------------------------- |
| `teamId`         | string      | Scope to one team. Omit for all teams.                                                 |
| `status`         | task status | Filter by one status (one of the 7). Ignored when `ready=true`.                        |
| `ready`          | `'true'`    | Return only ready-to-work tasks (deps satisfied). Overrides `status`/`includeDropped`. |
| `includeDropped` | `'true'`    | Include soft-deleted tasks.                                                            |

- **Request body**: none.

### Responses

**`200 OK`**: the task list, most recently updated first (the `ready=true` list puts the highest `priority` first, then the most recently updated). The `ready=true` rows carry none of `attention`, `runCost` and `runningSince`. Other sections call one of these rows `DbTask`:

```ts
{
  tasks: Array<{
    id: string
    title: string
    description: string | null
    status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
    priority: number
    teamId: string | null
    roomId: string | null // the chat room it was delegated in; null = the team's General chat
    assigneeAgentId: string | null
    assigneeRuntime: string | null
    parentTaskId: string | null
    sourceDelegationId: string | null
    worktreeRef: string | null
    branchRef: string | null
    costUsd: number // the sum of the task's recorded run costs (0 before any)
    parentSessionId: string | null
    dropped: number // 0 | 1 (soft-delete flag)
    tenantId: string | null // always null
    scheduledBy: string // 'manual' | 'clawboo' | runtime id
    verification: string | null // the check's result as JSON; null until a check runs
    createdAt: number
    updatedAt: number
    completedAt: number | null
    personMovedAt: number | null // when a person last moved the card (see PATCH below)
    // Why the task is waiting on a person; null when the board will move it on
    // its own. Not returned by the `ready=true` variant.
    attention: null | {
      reason:
        'failed' | 'timed_out' | 'stopped' | 'needs_review' | 'blocked' | 'unassigned' | 'unstarted'
      failedRuns: number // consecutive unsuccessful runs at the end of the ledger
      detail?: string // the last run's error, trimmed, for failed / timed_out
    }
    // What the task's runs cost, summed from its execution ledger. Not returned by
    // the `ready=true` variant.
    runCost: {
      usd: number | null // null when no run recorded a cost
      estimated: boolean // true when any part of usd is an estimate
      local?: true // present when every counted run ran on a local model, so the task cost nothing
    }
    // When the current run started (epoch ms); null when no run is going. Not
    // returned by the `ready=true` variant.
    runningSince: number | null
  }>
}
```

`attention` comes from the task's status, its bound agent (the `:agent:` segment of `sourceDelegationId`), its run ledger and its check result. A `blocked` task always has one (`needs_review` when its verdict cannot be promoted, else `timed_out` / `failed` from its last run, else `blocked`). A `todo` task has one only when nothing will fire it: no bound agent (`unassigned`), a last run the user stopped (`stopped`), or three failed runs in a row (`failed` / `timed_out`). An `in_progress` task with no assignee and no running run is `unstarted`: it was moved there by hand, which starts nothing. The board renders every task with an `attention` in its **Needs you** column.

`runCost` sums the `costUsd` of the task's run ledger rows. A row with no cost (a run stopped before it priced itself) adds nothing, and `usd` stays null until some run records one. `estimated` is true unless every counted row has `costSource` `'reported'` or `'local'`; a row with a null source counts as an estimate. `local: true` appears only when every counted row is `'local'`, a run on a model the user's own Ollama served, and the board then shows the cost as `free`. A task whose rows carry no cost but whose own `costUsd` is positive predates per-run costs, so that figure is returned with `estimated: true`.

**`500 Internal Server Error`**: a database failure:

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

Creates a task. `status` defaults to `todo` (ready to be claimed); pass `backlog` to park it. On success the route writes a `task_created` event to the [event log](/reference/rest-api/observability); a failed event write never fails the request.

Set `parentTaskId` to make a subtask. This route applies no child-count or depth limit (the Tasks MCP server's `create_subtask` does; see [MCP tools](/reference/mcp-tools)), and it does not copy the parent's team or room. A `parentTaskId` that does not exist fails the database's foreign key and answers **500**.

- **Path/query params**: none.
- **Request body**:

```ts
{
  title: string                 // required, 1 to 500 chars
  description?: string          // up to 20000 chars
  status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
  priority?: number             // integer
  teamId?: string               // non-empty if present
  assigneeRuntime?: string
  parentTaskId?: string
  sourceDelegationId?: string
  tenantId?: string             // non-empty if present
  assigneeAgentId?: string      // create the task FOR this agent (see below)
}
```

**With `assigneeAgentId`** (the board's New task dialog), the task is created for one agent: `teamId` is required, the agent must be an active member of that team, and `status` may only be `todo` (the default) or `backlog`. The server writes a `sourceDelegationId` that binds the task to the agent and marks it as assigned by a person, then, for a `todo` task, hands it to the team's engine to run now (the response does not wait for the run to start). The agent receives the title and description together. Its result is recorded on the task (the report comment) and is **not** delivered to the team lead as a task update: a person-assigned task reports to the person, on its card. If the agent is busy, the task waits in `todo` and runs when the agent is free.

### Responses

**`400 Bad Request`**: body failed validation (`{ "error": "invalid body", ... }`), or, with `assigneeAgentId`: `team_required`, `agent_not_in_team` (unknown, archived, or on another team), or `invalid_status`:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`200 OK`**: the created task, shaped as a `GET /api/board` row with `attention` and `runCost` (no `runningSince`):

```ts
{ task: { id: string, title: string, status: 'todo' /* ...the rest of the row */ } }
```

**`500 Internal Server Error`**: a database failure, including an unknown `parentTaskId`:

```json
{ "error": "<message>" }
```

### Example

```bash
curl -X POST http://localhost:18790/api/board \
  -H 'Content-Type: application/json' \
  -d '{"title":"Implement /api/foo","teamId":"<team-id>","priority":1}'

# Give one agent a task; it starts right away
curl -X POST http://localhost:18790/api/board \
  -H 'Content-Type: application/json' \
  -d '{"title":"Draft the launch post","description":"Under 200 words.","teamId":"<team-id>","assigneeAgentId":"<agent-id>"}'
```

---

## `POST /api/board/:taskId/retry`

Runs a stuck task again because a person asked: one that failed, timed out, was stopped, or was parked after failing three times in a row. A `blocked`, `backlog` or stranded `in_progress` task (no assignee and no run going) is moved back to `todo` first, which clears its assignee and check result. The route adds a `user` comment `Retry requested.` to the task and hands it straight to its bound agent. The board's automatic limit of three re-runs does not apply to a retry a person asks for. The response does not wait for the run to start.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`202 Accepted`**: the task as it now stands, in `todo`:

```ts
{ ok: true, task: DbTask }
```

**`404 Not Found`**: `{ "ok": false, "error": "task not found" }`.

**`409 Conflict`**: `{ "ok": false, "error": "<reason>" }`, where the reason is `not_retryable` (the task is running, finished or cancelled), `no_team`, or `unassigned` (no agent is bound to it; use `assign`).

**`500 Internal Server Error`**: `{ "ok": false, "error": "<message>" }`.

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/retry
```

---

## `POST /api/board/:taskId/assign`

Gives a task that nobody is working on to one member of its team, and starts it. Use it for a card no agent will pick up (created without one, or by an agent's own `create_task`), or to hand a failed task to someone else. The task is bound to the agent as a person's assignment (see `POST /api/board`), moved back to `todo` if it was `blocked`, `backlog` or stranded `in_progress` (no assignee and no run going), noted on its trail (`Assigned to <name>.`) and started.

- **Path params**: `taskId`.
- **Request body**: `{ agentId: string }`.

### Responses

**`200 OK`**: `{ "ok": true, "task": DbTask }`.

**`400 Bad Request`**: `{ "ok": false, "error": "agentId required" }`, or `agent_not_in_team` (the agent is unknown, archived or on another team).

**`404 Not Found`**: `{ "ok": false, "error": "task not found" }`.

**`409 Conflict`**: `no_team`, or `not_assignable` (the task is being worked on, finished, cancelled or dropped).

**`500 Internal Server Error`**: `{ "ok": false, "error": "<message>" }`.

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/assign \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>"}'
```

---

## `GET /api/board/:taskId`

Returns one task with its comments (oldest first) and its ancestors (the chain of parent tasks).

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`200 OK`**:

```ts
{
  task: DbTask & { attention; runCost; runningSince } // shape as in GET /api/board
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

Claims a `todo` task for one assignee. The claim succeeds only while the task is `todo`, unassigned and not dropped, so at most one caller wins: the task moves to `in_progress`, and every other caller gets **409**. A won claim writes a `task_claimed` event and posts a line to the team's peer room.

A **409** means another worker holds the task: do not retry it. A task left `in_progress` by a run that died is released back to `todo` by the server's stale-run cleanup, and a normal claim can then take it.

- **Path params**: `taskId`.
- **Request body**:

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

Changes a task's status, edits its `priority`, `title` or `description`, or both. At least one field is required. The status change follows the [status rules](#task-statuses) (an illegal move is **409** `illegal_transition`). A move to `done` is also refused with **409** `verification_required` when the task's stored check result is `fail`, or `completed_with_debt` with a failing last check. The only way past that is `humanOverride: true`, and a `done` with the override writes a `verification` row to the [audit log](/reference/rest-api/governance).

This is the route a **person** uses (the board and the task drawer), and a person's move is the final word on the task:

- A move to `done` or `cancelled` may carry `completedAt`, the day it really finished. It must fall between the task's creation and now (up to 5 minutes ahead of the server clock is allowed), else **400** `invalid_completed_at`. Without it the finish time is now. Writing the same finished status again never moves the finish time.
- A move to `cancelled` also cancels the task's pending (`todo` / `backlog`) dependents, which could otherwise never run, and returns them as `cancelledDependents`.
- A move to `backlog`, `todo`, `blocked`, `done` or `cancelled` stops the run working on the task, whether team chat, the task runner or an OpenClaw Routine fire started it, and closes its ledger row as cancelled. A move to `in_progress` or `in_review` stops nothing. A task moved back to `todo` while it was running is started again for its bound agent.
- Whoever delegated the task (the `:reflectTo:` agent in its `sourceDelegationId`) is told a person marked it done or cancelled it: through a `[Task Update]` when the team's engine is running, else as a mailbox notice read at its next turn. A task a person assigned reports to nobody.
- The move is stamped on the task as `personMovedAt`. Until a run starts after it, the agent's own status writes through the [tasks MCP tools](/reference/mcp-tools) (`update_task_status`, `block_task`, `unblock_task`) are refused with a tool error that names the column the person chose and tells the agent not to retry, so the run the person overruled cannot put the card back. A run that starts after the move writes as usual.

<Note>

A task with no stored check result is unchecked, not failing, and moves to `done` normally. Most tasks never get a check: only task-runner runs in a git worktree with a non-empty diff are checked (see [Verification](/concepts/verification)). Moving a task to `todo` clears its assignee and check result so it can be claimed again.

</Note>

A status change writes a `status_changed` event and posts `A person moved "<title>" to <Status>.` to the team's peer room.

- **Path params**: `taskId`.
- **Request body** (at least one field required):

```ts
{
  status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
  priority?: number             // integer
  title?: string                // 1 to 500 chars
  description?: string          // up to 20000 chars
  humanOverride?: boolean        // move to done despite a failed check (audited); only with status 'done'
  completedAt?: number           // epoch ms; only with status 'done' or 'cancelled'
}
```

### Responses

**`400 Bad Request`**: empty body or failed validation (including `completedAt` without a move to `done` or `cancelled`), or `{ ok: false, error: 'invalid_completed_at' }` for a finish time outside the task's life:

```json
{
  "error": "invalid body",
  "details": { "formErrors": ["at least one field required"], "fieldErrors": {} }
}
```

**`200 OK`**: applied; the updated task, and on a move to `cancelled` the dependents cancelled with it:

```ts
{ ok: true, task: DbTask, cancelledDependents?: Array<{ id: string; title: string }> }
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

Adds a comment to a task (discussion or a system note). `authorType` defaults to `agent`. The route writes a `comment_added` event and posts the first 160 characters to the team's peer room. An unknown `taskId` is not checked first: the insert fails the database's foreign key and the route answers **500** (`FOREIGN KEY constraint failed`).

A `user` comment is a person's reply. After the comment is saved, the route delivers it to the agent the task belongs to: the assignee, or else the agent named in the task's `sourceDelegationId` (a task moved back to `todo` keeps that binding). Nothing is delivered when there is no such agent, or when the task is `done`, `cancelled` or dropped.

1. **The mailbox**, always first. The agent's inbox gets `A person commented on your task "<title>": ...` with the comment's first 1000 characters. Every run reads the inbox when it starts.
2. **Then by status:**
   - `in_progress` with a run working on it: a steer into that run. How it gets in depends on the runtime (see [Choose a runtime](/runtimes/index)). The route waits up to 2.5 seconds for the steer to land, and the steer carries on in the background after that. When it lands, the mailbox row is marked delivered so the agent does not read the comment twice.
   - `blocked`, `todo`, or `in_progress` with no assignee and no run going: the task is started again, as the retry route above does. A task that is not `todo` moves there first (with a `status_changed` event whose reason is `reply`). If every task it depends on is `done`, the route adds the `system` comment `Started again for a person’s reply.` and dispatches the task to its agent; otherwise the reply waits in the mailbox. A `todo` task that a reply started less than 15 seconds ago is not dispatched again.
   - `in_review` and `backlog`: the reply waits in the mailbox.

A task with no team, or one whose move back to `todo` is refused, is not started again: the reply waits in the mailbox for its next run.

- **Path params**: `taskId`.
- **Request body**:

```ts
{
  body: string                          // required, 1 to 20000 chars
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
  forwarded: boolean // true when `delivery` is present and its status is not 'not-delivered'
  delivery?: // present for a `user` comment only
    | { status: 'steered'; agentId: string }
    | { status: 'woke-agent'; agentId: string }
    | { status: 'queued'; agentId: string; reason: 'next-run' | 'in-review' | 'waiting' }
    | {
        status: 'not-delivered'
        agentId: string | null
        reason: 'finished' | 'unassigned' | 'failed'
      }
}
```

`delivery` says where a person's reply went. `agentId` is the agent the task belongs to.

| `status`        | `reason`     | Meaning                                                                                                                                                        |
| --------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steered`       |              | The reply got into the run working on the task                                                                                                                 |
| `woke-agent`    |              | The task was started again for the reply, or a reply less than 15 seconds earlier already started it                                                           |
| `queued`        | `next-run`   | The reply is in the mailbox for the agent's next run, for example on a `backlog` task, or on an `in_progress` task whose steer did not land within 2.5 seconds |
| `queued`        | `in-review`  | The task is `in_review`; the agent reads the reply after the check                                                                                             |
| `queued`        | `waiting`    | The task waits on a dependency that is not `done`, so it cannot start yet                                                                                      |
| `not-delivered` | `finished`   | The task is `done`, `cancelled` or dropped. The comment is saved and nothing is sent                                                                           |
| `not-delivered` | `unassigned` | No agent has the task, and `agentId` is `null`                                                                                                                 |
| `not-delivered` | `failed`     | Writing to the mailbox or starting the task failed. The comment is saved, and the route still answers `200` so the reply is not sent twice                     |

For a `finished` reply, the dashboard offers **Send as a follow-up task**, which calls `POST /api/board` (above) with `title: "Follow up: <title>"`, the reply as `description`, the same `teamId` and `assigneeAgentId`, and the finished task as `parentTaskId`.

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
# An agent's note
curl -X POST http://localhost:18790/api/board/<task-id>/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Blocked on the upstream schema.","authorType":"agent","authorAgentId":"native-leader-abc"}'

# A person's reply, which answers with `delivery`
curl -X POST http://localhost:18790/api/board/<task-id>/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Use the v2 schema; it landed this morning.","authorType":"user"}'
```

---

## `POST /api/board/:taskId/executions`

Opens a row in the task's run ledger, after a successful claim. The server reads the ledger after a restart to find runs that died: a worker that starts work must open a row here and close it with the `PATCH` below. A row left open by a crash is marked `failed` and its task released. A new row writes an `execution_started` event.

- **Path params**: `taskId`.
- **Request body**:

```ts
{
  executorType: string          // required, 1 to 100 chars (the runtime id)
  workspaceId?: string
  runReason?: string            // up to 2000 chars
  beforeCommit?: string         // up to 200 chars (git checkpoint)
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
    // The runtime that actually ran, when executorType names an owner instead: the
    // team engine records every run it starts as 'openclaw'. Null otherwise.
    runtime: string | null
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
    // How costUsd was obtained; null when no cost is recorded or the row predates
    // the column (the board then treats a recorded cost as an estimate).
    costSource: 'reported' | 'local' | 'token-estimate' | 'char-estimate' | null
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

Closes a run in the ledger with its outcome, and optionally its tokens and cost. The route writes an `execution_completed` event carrying the run's `taskId`, `teamId`, `agentId` and `runtime`, so it pairs with the `execution_started` event. A closed row never changes again, so only a `running` row can be closed: an unknown `execId`, or one already closed elsewhere, closes nothing and answers `404` without an event.

- **Path params**: `execId`.
- **Request body**:

```ts
{
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'   // required
  summary?: string              // up to 20000 chars
  error?: string                // up to 20000 chars
  afterCommit?: string          // up to 200 chars
  inputTokens?: number          // integer
  outputTokens?: number         // integer
  cacheRead?: number            // integer
  cacheWrite?: number           // integer
  costUsd?: number
  costSource?: 'reported' | 'local' | 'token-estimate' | 'char-estimate'
}
```

A token or cost field the body omits leaves the row's value as it is, so closing a row never erases a cost already recorded on it. These fields take a number or are left out; a `null` fails validation with `400`. A `costUsd` sent without a `costSource` is stored with a null source, which the board counts as an estimate. A close that records a cost also refreshes the task's `costUsd`, the sum of its rows.

### Responses

**`400 Bad Request`**: body failed validation:

```json
{ "error": "invalid body", "details": { "formErrors": [], "fieldErrors": {} } }
```

**`200 OK`**: the execution was closed:

```json
{ "ok": true }
```

**`404 Not Found`**: no still-`running` execution row matched `execId`, either because the id is unknown or because the row is already terminal (most often the stale sweep closed it as `timed_out`). Nothing was closed and no event was appended, and this 404 is data rather than a transient error to retry:

```json
{ "error": "execution not found" }
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

Lists every run in the task's ledger, oldest first.

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

Makes `taskId` wait for `dependsOnTaskId`: it is not ready until the other task is `done`. A plan is a chain of these links, and the team's engine starts the next step when the one before it finishes. Both tasks must exist. A new link writes a `dep_linked` event and posts a line to the team's peer room.

- **Path params**: `taskId` (the dependent).
- **Request body**:

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

**`409 Conflict`**: the edge would close a direct or transitive **dependency cycle**. A cycle can never resolve, so the plan is unworkable rather than the server being at fault:

```json
{ "ok": false, "error": "task_dependency_cycle" }
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

Cancels the tasks still waiting (`todo` or `backlog`) behind a failed task, directly or further down the chain. A failed task never becomes `done`, so those tasks could never run; cancelling them shows the stall instead of leaving cards that never become ready. Tasks in any other status (`in_progress`, `in_review`, `blocked`, `done` or `cancelled`) are left alone. Each cancelled task writes a `status_changed` event with `reason: 'blocker_failed'`, and the response lists them so the caller can tell the team lead.

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

Creates a git worktree and a `clawboo/task-<id>` branch for a task that changes files, writes the task files into it, and records the worktree and branch on the task. The task files are `TASK.md`, `task-progress.md`, `DECISIONS.json`, `init.sh` and `VERIFICATION.md` (plus `AGENT_HANDOFF.json` once someone writes a handoff); the other workspace routes read them. The worktree lives outside your repo, at `<clawboo home>/worktrees/<repo hash>/<taskId>`, so it never shows up in the repo's own `git status`. A worktree keeps file changes apart; it is not a sandbox (see [What agents can do](/concepts/permissions)).

The task `kind` decides whether a worktree is made: `code` (the default) and any unknown kind get one; `research` and `review` are refused with **422**. Asking again for a task that already has a live worktree reuses it.

- **Path params**: `taskId`.
- **Request body**:

```ts
{
  repoPath: string              // required, 1 to 4000 chars: the git repo to branch from
  baseSha?: string              // up to 200 chars: pins the branch point
  baseRef?: string              // up to 400 chars: the branch point (default HEAD) when no baseSha
  kind?: string                 // up to 100 chars: the task kind, which decides isolation; default 'code'
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

**`422 Unprocessable Entity`**: the task kind gets no worktree (`research` or `review`):

```ts
{ ok: false, error: 'no_isolation', isolation: 'none' }
```

**`200 OK`**: the worktree was provisioned (or an existing one reused):

```ts
{
  ok: true
  worktree: {
    taskId: string
    worktreePath: string // absolute path to the checkout
    branch: string // 'clawboo/task-<id>'
    baseCommit: string // the commit holding the task files: the diff baseline
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

Reads the task's workspace row and the state to resume from, rebuilt only from the worktree's task files (`AGENT_HANDOFF.json`, else `task-progress.md` and `init.sh`): no chat history and no board state. A different runtime, or a person, can pick the task up from this alone.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`404 Not Found`**: no workspace row for the task (or it has no recorded worktree path):

```json
{ "error": "workspace not found" }
```

**`200 OK`**: the workspace, the resume state and the parsed handoff (`resume` and `handoff` are `null` when the worktree is paused or no handoff was written):

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

- **`pause`**: commits any uncommitted work, removes the worktree and keeps the branch. The workspace stays `active` and can be resumed.
- **`complete`** with an empty diff: removes the worktree and branch and moves the task to `done`. There is nothing to check, so the check is skipped. The task files do not count toward the diff, so a run that only updated its own progress or handoff is still empty.
- **`complete`** with a non-empty diff: moves the task to `in_review` and runs the check. Only a `pass` moves it to `done`. A `fail` with attempts left moves it back to `in_progress`. A `fail` on the last attempt, or `completed_with_debt`, moves it to `blocked` with a system comment and a mailbox notice to whoever delegated it. A repeat `complete` on a `blocked` task does not run the check again; it returns the current status with `verified: 'fail'`.

Through this route the check is the task's own verify command only; the separate reviewer pass never runs. The command is `VERIFY_CMD` in the worktree's `init.sh` (else the `Verify:` line in `VERIFICATION.md`). The task files start with a placeholder command, which counts as no command, so the check fails until a real one is set. If a person moves the task to `done` or `cancelled` while the check runs, their move stands and the result is only recorded. See [Verification](/concepts/verification).

- **Path params**: `taskId`.
- **Request body**:

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

# Complete (runs the check when the diff is not empty)
curl -X PATCH http://localhost:18790/api/board/<task-id>/workspace \
  -H 'Content-Type: application/json' \
  -d '{"action":"complete"}'
```

---

## `POST /api/board/:taskId/workspace/handoff`

Writes `AGENT_HANDOFF.json` into the task's worktree: structured notes on what was done, what is broken and what to do next, so a different runtime or a person can pick the task up. When `timestamp` is left out, the server fills in the current ISO-8601 time.

- **Path params**: `taskId`.
- **Request body** (`timestamp` defaulted server-side):

```ts
{
  handoffFrom: string                 // required, non-empty: who is handing off
  runtime: string                     // required, non-empty: the runtime that produced it (may be 'human')
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

The task drawer's workspace view: the contents of the task files that exist (`TASK.md`, `task-progress.md`, `DECISIONS.json`, `init.sh`, `VERIFICATION.md`, `AGENT_HANDOFF.json`), plus the unified diff and diff stats against the starting commit, with the task files left out of the diff.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`404 Not Found`**: no workspace row (or it has no worktree path):

```json
{ "error": "workspace not found" }
```

**`200 OK`**: the task files and the diff (`diffStat` and `diff` are empty when the worktree is paused or git is unavailable):

```ts
{
  ok: true
  workspace: DbWorkspace        // shape as in GET .../workspace
  sorFiles: Record<string, string>   // task file contents, keyed by file name
  diffStat: { filesChanged: number, insertions: number, deletions: number, dirty: boolean } | null
  diff: string                  // unified diff without the task files; '' when unavailable
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

## The workspace file view

Four read-only routes behind an agent's **Workspace** tab. They serve a task's worktree: one directory level, one file, one file's diff, and the git status behind the change badges. Nothing here writes.

The worktree path comes from the stored workspace row, never from the request. Every relative path is kept inside the worktree in three ways: absolute paths and `..` segments are refused; the resolved path must sit inside the root (so a sibling such as `<root>-evil` cannot pass as `<root>`); and symlinks are refused outright, with the path checked again after resolving any symlinked parent folder. Backslashes, control characters and paths over 1024 characters are refused too. A refused path answers **400** `{ "ok": false, "error": "<what is wrong>" }`.

When the workspace itself cannot be read, all four answer `{ "ok": false, "error": "<message>", "reason": "<reason>" }`:

| Status | `error`                | `reason`     | Meaning                                                                                   |
| ------ | ---------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `404`  | `workspace not found`  | `not_found`  | No workspace row, or the row has no worktree path                                         |
| `404`  | `workspace not found`  | `gone`       | The row exists but the checkout is not on disk (paused or cleaned up; the branch remains) |
| `409`  | `workspace unreadable` | `unreadable` | The checkout is on disk but git refuses it (moved repo, corrupt index)                    |

`unreadable` is not a 404 on purpose: a client that read a git failure as "no workspace" would show a changed worktree as clean.

### `GET /api/board/:taskId/workspace/tree`

One directory level, for a tree that expands on demand. `.git`, symlinks and special files are left out; folders sort before files, then by name, ignoring case.

- **Query**: `dir` (relative to the worktree; empty or left out lists the root).
- **`200 OK`**: `{ ok, dir, entries: [{ name, kind: "file" | "dir", size? }], truncated }`. Only files carry `size`. At most 500 entries; `truncated` says the limit was hit.

### `GET /api/board/:taskId/workspace/file`

One file's contents, up to 256 KB.

- **Query**: `path` (relative to the worktree).
- **`200 OK`** (text): `{ ok, path, binary: false, size, content, truncated }`. A cut falls on a character boundary, so a truncated file never ends in a broken character.
- **`200 OK`** (binary): `{ ok, path, binary: true, size }`. A NUL byte in the first 8 KB marks the file as binary, and no bytes are returned.

### `GET /api/board/:taskId/workspace/file-diff`

The unified diff for one file against the task's starting commit.

- **Query**: `path` (relative to the worktree). A folder is refused with **400** `Not a file.`, since a git path match would otherwise return everything under it.
- **`200 OK`**: `{ ok, path, diff, truncated }`, capped at 1 MB. The diff is empty for an untracked file; show the file's contents instead.

### `GET /api/board/:taskId/workspace/status`

`git status --porcelain -z --untracked-files=all` for the worktree, parsed.

- **`200 OK`**: `{ ok, branch, entries: [{ path, x, y, origPath? }], truncated }`. `x` is the index column and `y` the worktree column; `origPath` is the source of a rename or copy. At most 2000 entries.

### Example

```bash
curl 'http://localhost:18790/api/board/<task-id>/workspace/tree?dir=src'
curl 'http://localhost:18790/api/board/<task-id>/workspace/file?path=src/index.ts'
```

---

## `GET /api/board/:taskId/preview` and `GET /api/board/:taskId/preview/<path>`

Serves the files in a task's worktree as a static website, so the task drawer's **Preview** can show the page an agent built next to the diff. It only serves files: it never runs a build or a dev server. The drawer checks for a preview every 10 seconds while it is open.

- `GET /api/board/:taskId/preview` and `GET /api/board/:taskId/preview/<path>` serve the same tree. A folder (including the bare route) serves its `index.html`. A folder URL without a trailing slash answers `302` to the same URL with a `/` added (the base path and query are kept), so the page's relative links resolve.
- Paths follow the same rules as the [workspace file view](#the-workspace-file-view): no absolute paths, `..`, symlinks, backslashes or control characters, and at most 1024 characters.
- `Content-Type` comes from a fixed list: `html`/`htm`, `css`, `js`/`mjs`, `json`/`map`, `txt` and `md` (as `text/plain`), `svg`, `png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `ico`, `woff`/`woff2`, `ttf`, `otf`, `mp4`, `webm`, `wasm`. Anything else is sent as `application/octet-stream`, which a browser downloads rather than runs.
- Every file is sent with `Content-Length`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and streamed.
- The routes sit under `/api`, so the same-origin guard and the access gate apply, and the dashboard's access cookie reaches the preview frame.

The drawer shows the page in a frame that runs no scripts, so a script-driven page appears as its static shell. The **Open** link shows the same URL in a new tab without that restriction: there the page's scripts run in the dashboard's origin and can call this API, so open it only for work you trust.

### Responses

**`200 OK`**: the file's bytes.

**`302 Found`**: a folder requested without a trailing slash.

**`400 Bad Request`**: a refused path, or a missing file. The message names the problem, for example:

```json
{ "ok": false, "error": "No such file in the workspace." }
```

**`404 Not Found`**: `{ "ok": false, "error": "<message>" }`, where the message is `workspace not_found` or `workspace gone` (no usable worktree), `No index.html in that directory.`, or `Not a file.`

**`413 Payload Too Large`**: a file over 8 MB: `{ "ok": false, "error": "That file is too large to preview." }`

**`500 Internal Server Error`**: `{ "error": "<message>" }` (or `preview read failed` when the file cannot be read).

### Example

```bash
# The worktree's index.html (follow the redirect to preview/)
curl -L http://localhost:18790/api/board/<task-id>/preview

# One asset
curl -I http://localhost:18790/api/board/<task-id>/preview/dist/app.css
```

---

## Error envelope

Most error bodies are `{ "error": "<message>" }`. The exceptions:

- Validation `400`s add `details` (the zod `flatten()` output): `{ "error": "invalid body", "details": {...} }`, or `invalid handoff` on the handoff route.
- `{ "ok": false, "error": "<reason>" }` comes from: the claim (`not_found`, `conflict`); a status change on `PATCH /api/board/:taskId` (`not_found`, `illegal_transition`, `verification_required`, and `invalid_completed_at` as a `400`); every retry and assign failure (`task not found`, `agentId required`, `not_retryable`, `no_team`, `unassigned`, `agent_not_in_team`, `not_assignable`); the dependency cycle (`409 task_dependency_cycle`); the provision route (`task not found`, and `no_isolation` with `isolation`); and the pause, complete and handoff `404`s (`workspace not found`).
- The workspace file view adds `reason` to its misses and answers a refused path with `{ "ok": false, "error": "<message>" }`.
- The preview routes answer `{ "ok": false, "error": "<message>" }` on `400`, `404` and `413`.
- `GET /api/board/:taskId/workspace` and `/workspace/detail` answer a missing workspace with a bare `{ "error": "workspace not found" }`.

An unknown `taskId` on a comment, or an unknown `parentTaskId` on a create, is a `500` from the database's foreign key, not a `404`.

## Related

- [The board](/concepts/the-board): statuses, claims, dependencies and how stuck tasks are recovered.
- [Worktrees and handoff](/concepts/worktrees-and-handoff): the task files and `AGENT_HANDOFF.json` across runtimes.
- [Verification](/concepts/verification): which tasks are checked, and what `completed_with_debt` means.
- [Runtimes API](/reference/rest-api/runtimes): `POST /api/runtimes/:id/run` claims one of these tasks and runs it.
- [Database schema](/reference/database-schema): the `tasks`, `task_deps`, `task_comments`, `workspaces` and `execution_processes` tables.
