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

Retry, Assign, creating a task for a named agent or for yourself, completing a worktree, Reopen, assigning a task to a person, answering a question, answering the card about agents waking each other, a task's labels, a read mark, a status change and a `user` comment act for a person, so they go through [the person check](/operating/security#the-person-check): the request must come from the dashboard's own page, or from a person a sign-in proxy vouched for. All but the status change and the comment refuse any other caller with **403** `person_only`, in `{ "ok": false, "error": "person_only" }` or `{ "error": "person_only" }`. A status change from another caller still happens, without a person's authority (see `PATCH` below). A script acting for you can send `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: cors`, as the examples below do. This is a speed bump on your own computer: agents run as your user account and can send the same headers.

</Info>

<Info>

A claim is how agents share work without doing it twice: `POST /api/board/:taskId/claim` answers **409** when another worker already holds the task. **A 409 is an answer, not a transient error; do not retry it.** The task is simply taken. The same applies to `409 illegal_transition` on `PATCH /api/board/:taskId`.

</Info>

## Routes

| Method | Path                                      | Summary                                                       | Stream? |
| ------ | ----------------------------------------- | ------------------------------------------------------------- | ------- |
| GET    | `/api/board`                              | List tasks (or the ready-to-work ones)                        | No      |
| GET    | `/api/pauses`                             | Every pause: agents, teams and task trees                     | No      |
| POST   | `/api/pauses`                             | Pause an agent, a team or a task's tree. A person's route     | No      |
| DELETE | `/api/pauses/:kind/:id`                   | Resume it. A person's route                                   | No      |
| POST   | `/api/board`                              | Create a task (optionally for one agent, started at once)     | No      |
| POST   | `/api/board/:taskId/retry`                | Run a stuck task again, straight to its agent                 | No      |
| POST   | `/api/board/:taskId/assign`               | Give an unowned task to one team member and start it          | No      |
| POST   | `/api/board/:taskId/reopen`               | A person reopens a finished task                              | No      |
| POST   | `/api/board/:taskId/assign-person`        | Give a task to a person, or take a person off                 | No      |
| GET    | `/api/board/:taskId/questions`            | The questions agents asked on a task                          | No      |
| POST   | `/api/board/questions/:questionId/answer` | A person answers a question                                   | No      |
| POST   | `/api/board/agent-wakes/:jobTaskId`       | A person answers the card about agents waking each other      | No      |
| GET    | `/api/board/inbox`                        | What is unread and what needs the person, for the badge       | No      |
| POST   | `/api/board/inbox/read`                   | Mark everything read, or one team's tasks                     | No      |
| POST   | `/api/board/:taskId/read`                 | Mark one task read, through the change the page showed        | No      |
| GET    | `/api/board/:taskId`                      | One task with its comments and parent chain                   | No      |
| POST   | `/api/board/:taskId/claim`                | Claim a `todo` task for one agent (409 if taken)              | No      |
| PATCH  | `/api/board/:taskId`                      | Change status (checked) and edit title, description, priority | No      |
| POST   | `/api/board/:taskId/comments`             | Add a comment (a person's reply reaches the task's agent)     | No      |
| PUT    | `/api/board/:taskId/labels`               | Replace a task's labels (dashboard only)                      | No      |
| POST   | `/api/board/:taskId/executions`           | Open a run in the ledger (after a claim)                      | No      |
| PATCH  | `/api/board/executions/:execId`           | Close a run with its outcome, tokens and cost                 | No      |
| GET    | `/api/board/:taskId/executions`           | The task's run ledger                                         | No      |
| POST   | `/api/board/:taskId/deps`                 | Make one task wait for another                                | No      |
| POST   | `/api/board/:taskId/cancel-dependents`    | Cancel the waiting tasks behind a failed one                  | No      |
| POST   | `/api/board/:taskId/workspace`            | Create the task's worktree, branch and task files             | No      |
| GET    | `/api/board/:taskId/workspace`            | Read the workspace and the state to resume from               | No      |
| PATCH  | `/api/board/:taskId/workspace`            | `pause` or `complete` the worktree                            | No      |
| POST   | `/api/board/:taskId/workspace/handoff`    | Write `AGENT_HANDOFF.json` for the next runtime or person     | No      |
| GET    | `/api/board/:taskId/workspace/detail`     | Task file contents and the diff (the task drawer view)        | No      |
| GET    | `/api/board/:taskId/workspace/tree`       | One directory level of the worktree                           | No      |
| GET    | `/api/board/:taskId/workspace/file`       | One file, size-capped                                         | No      |
| GET    | `/api/board/:taskId/workspace/file-diff`  | One file's diff against the starting commit                   | No      |
| GET    | `/api/board/:taskId/workspace/status`     | `git status` for the worktree                                 | No      |
| GET    | `/api/board/:taskId/preview`              | Serve the worktree's `index.html` (redirects to `preview/`)   | No      |
| GET    | `/api/board/:taskId/preview/<path>`       | Serve one file from the worktree, for the preview frame       | No      |

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

Lists tasks, for one team or all of them, or only the tasks that are ready to work. With `ready=true` the list holds `todo` tasks that are not dropped and whose dependencies are all `done`, in the order they are served: tasks that ran before first, then aged priority, then oldest first. A task a pause covers is still listed there. Each row of the full list, and `task` in `GET /api/board/:taskId`, carries `pause`: the [pause](/using/board#pause-work) covering the task, or `null`. Otherwise it is filtered by `teamId`, `status` and `includeDropped`. Dropped (soft-deleted) tasks are left out unless `includeDropped=true`.

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
    identifier: string | null // the readable id, like MAR-12; null for a task with no team
    labels: Array<{ id: string; name: string }>
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
    runnerInputs: string | null // JSON: what the task runner ran it with; null if it never did (see retry below)
    checkHeldSince: number | null // when its team-chat check began waiting for the team folder; null otherwise
    waitingOn: string | null // JSON: what it waits for, a kind and what it points at (see below)
    assigneePersonId: string | null // the person it is assigned to; never with assigneeAgentId
    assigneePerson: string | null // JSON { id, name, role } of that person
    requestedBy: string | null // JSON { id, name, role } of the person who asked for it
    // The question it has open, when it waits on one. Not returned by the `ready=true` variant.
    openQuestion: null | { id: string; kind: string; payload: string; status: 'pending' /* ... */ }
    // For a task waiting on other work: the title of the task, or how many sub-tasks are open.
    waitingOnDetail?: { taskTitle?: string; openSubtasks?: number }
    // Why the task is waiting on a person; null when the board will move it on
    // its own. Not returned by the `ready=true` variant.
    attention: null | {
      reason:
        | 'failed'
        | 'timed_out'
        | 'stopped'
        | 'needs_review'
        | 'blocked'
        | 'unassigned'
        | 'unstarted'
        | 'question'
        | 'assigned'
      failedRuns: number // consecutive unsuccessful runs at the end of the ledger
      detail?: string // the last run's error, trimmed, for failed / timed_out; what a person must do
      byPerson?: true // for blocked: a person moved it there and no run has started since
      questionId?: string // for question: the question waiting for its answer
      personId?: string // for assigned: the person whose turn it is
      handedBack?: true // for assigned: an agent handed it back
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

`attention` comes from the task's status, its bound agent (the `:agent:` segment of `sourceDelegationId`), its run ledger, its check result, what it waits on and who it is assigned to. A `blocked` task whose agent's comment still waits on the card about agents waking each other is `agent_wakes`, with `agentWakes: { jobTaskId, kind, fromAgentId, toAgentId, alsoWaiting? }`. `alsoWaiting` counts the other tasks that wait on the same answer, and a card nothing waits on any more is not shown. A question waiting for its answer is `question`, and an open task assigned to a person is `assigned`, unless it is in `backlog`; both come first. A `blocked` task has one (`needs_review` when its verdict cannot be promoted, else `timed_out` / `failed` from its last run, else `needs_review` when it waits on a check, else `blocked`), unless it waits on another task or on its own sub-tasks: then it has none. A check whose move to Blocked keeps failing is `needs_review` while still `in_review` or `in_progress`. A `todo` task has one only when nothing will fire it: no bound agent (`unassigned`), a last run the user stopped (`stopped`), or three failed runs in a row (`failed` / `timed_out`). An `in_progress` task with no assignee and no running run is `unstarted`: nothing is working on it. The board renders every task with an `attention` in its **Needs you** column.

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

Set `parentTaskId` to make a subtask. This route applies no child-count or depth limit (the Tasks MCP server's `create_subtask` and the team engine's hand-offs do; see [MCP tools](/reference/mcp-tools)), and it does not copy the parent's team or room. A `parentTaskId` that does not exist fails the database's foreign key and answers **500**.

- **Path/query params**: none.
- **Request body**:

```ts
{
  title: string                 // required, 1 to 500 chars
  description?: string          // up to 20000 chars
  status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
  priority?: number             // integer: 2 urgent, 1 high, 0 normal (default), -1 low; held to that range
                                // urgent only through the person check; anything else stops at 1
  teamId?: string               // non-empty if present
  assigneeRuntime?: string
  parentTaskId?: string
  sourceDelegationId?: string
  tenantId?: string             // non-empty if present
  assigneeAgentId?: string      // create the task FOR this agent (see below)
  assignToMe?: boolean          // create the task for the sender; takes the person check
  idempotencyKey?: string       // 1 to 200 chars; the same key, within a team, returns the same task
}
```

**`sourceDelegationId`** takes [the person check](/operating/security#the-person-check) when it names an agent (`:agent:<id>`), who hears the result (`:reflectTo:<id>`) or says a person chose (`origin:human`): the engine reads those as a binding and fires it. Any other caller gets **403** `person_only`, with nothing written.

`assignToMe` makes the task the sender's own: nothing starts it. It cannot go with `assigneeAgentId` (`400 one_assignee`), and a request that does not pass [the person check](/operating/security#the-person-check) gets `403 person_only`. A task created from the dashboard's page, or by a person a sign-in proxy vouched for, records them in `requestedBy`, which is where an agent's hand-back goes.

**With `idempotencyKey`** (the New task dialog sends one per draft), a repeat returns the task the key first made, with `deduplicated: true` beside `task`. It writes no event and starts no run. This route skips the same-title check that agents' creates go through: a person's two tasks with one title are two tasks.

**With `assigneeAgentId`** (the board's New task dialog), the task is created for one agent, which takes the same check: `teamId` is required, the agent must be an active member of that team, and `status` may only be `todo` (the default) or `backlog`. The server writes a `sourceDelegationId` that binds the task to the agent and marks it as assigned by a person, then, for a `todo` task, hands it to the team's engine to run now (the response does not wait for the run to start). The agent receives the title and description together. Its result is recorded on the task (the report comment) and is **not** delivered to the team lead as a task update: a person-assigned task reports to the person, on its card. If the agent is busy, the task waits in `todo` and runs when the agent is free.

### Responses

**`403 Forbidden`**: `{ "ok": false, "error": "person_only" }`: `assigneeAgentId` or a `sourceDelegationId` naming an agent was set, and the request did not pass the person check. Nothing was written.

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

# Give one agent a task; it starts right away (a person's request only)
curl -X POST http://localhost:18790/api/board \
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Draft the launch post","description":"Under 200 words.","teamId":"<team-id>","assigneeAgentId":"<agent-id>"}'
```

---

## `GET /api/pauses`

Every pause, oldest first. A person pauses an agent, a team or a task tree, and nothing it covers starts until they resume it; see [Pause work](/using/board#pause-work). A pause whose agent or team has been deleted is not listed.

```ts
{
  pauses: Array<{
    kind: 'agent' | 'team' | 'task_tree'
    id: string // the agent or team, or the tree's root task
    name: string // the agent's or team's name, or the root task's title
    reason: string | null
    pausedBy: { id: string; name: string | null; role: string | null } | null // null: the local person
    pausedAt: number
  }>
}
```

## `POST /api/pauses`

Pauses it, and stops the runs it covers without waiting for them: the pause holds as soon as this answers. Pausing something already paused changes nothing, and the first pause's reason and time stand. It takes [the person check](/operating/security#the-person-check).

- **Request body**: `{ kind: 'agent' | 'team' | 'task', id: string, reason?: string }`. `task` names any task in a tree, and the tree is paused from its root. `reason` is at most 200 characters.

**`201 Created`** when this paused it, **`200 OK`** when it already was: `{ ok: true, created: boolean, pause }`.

**`400 Bad Request`**: a bad `kind`, `id` or `reason`. **`403 Forbidden`**: `{ "ok": false, "error": "person_only" }`. **`404 Not Found`**: `{ "ok": false, "error": "not_found" }`.

## `DELETE /api/pauses/:kind/:id`

Resumes it, and waiting work starts again at once. `:kind` is `agent`, `team`, `task` (any task in the tree) or `task_tree`. It takes [the person check](/operating/security#the-person-check).

**`200 OK`**: `{ ok: true }`. **`403 Forbidden`**: `{ "ok": false, "error": "person_only" }`. **`404 Not Found`**: `{ "ok": false, "error": "not_paused" }`.

## `POST /api/board/:taskId/retry`

Runs a stuck task again because a person asked: one that failed, timed out, was stopped, or was parked after failing three times in a row. A `blocked`, `backlog` or stranded `in_progress` task (no assignee and no run going) is moved back to `todo` first, which clears its assignee and check result. The route adds a `user` comment `Retry requested.` to the task and hands it straight to its bound agent. The board's automatic limit of three re-runs does not apply to a retry a person asks for. The response does not wait for the run to start.

**A task the task runner ran** (an agent Routine, or `POST /api/runtimes/:id/run`) has `runnerInputs`, and goes back through the runner with them: the same repository and isolation kind, so it gets a worktree when the task names a repository, and its check again. Its agent is the bound one, else the one the runner ran it for, and it needs no team. The run uses that agent's runtime, and the saved model only on the saved runtime. A removed agent runs nothing, and neither does an id with no agent row unless it is the saved runtime's own id (the id the run route uses when it names no agent). When the runner cannot run the agent, such as one on OpenClaw, the task goes to team chat if an agent is bound to it, and answers `409 unassigned` if none is. A task with no `runnerInputs`, which includes tasks the runner ran before it started saving them, goes to its team's chat as before.

A runner rerun that does not start (the runner refuses it, for example because a budget is paused at its hard cap, or it times out waiting for the agent) moves the task to `blocked` with a `system` comment that gives the reason. A Retry or Assign stops a rerun of the same task that is still waiting to start. Team chat never fires a task the runner reruns: when its run fails and it goes back to `todo` with an agent bound, the server re-fires it through the runner, under the same three-runs limit.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`202 Accepted`**: the task as it now stands, in `todo`:

```ts
{ ok: true, task: DbTask }
```

**`403 Forbidden`**: `{ "ok": false, "error": "person_only" }`: the request did not pass the person check. Nothing was written. To put a stuck task back without a person's authority, move it to `todo` with `PATCH`, where the board's automatic limits still apply.

**`404 Not Found`**: `{ "ok": false, "error": "task not found" }`.

**`409 Conflict`**: `{ "ok": false, "error": "<reason>" }`, where the reason is `not_retryable` (the task is running, finished or cancelled), `no_team` (it has no team and is not a task-runner rerun), `unassigned` (no agent is bound to it, and the runner cannot rerun it for the agent it ran it for; use `assign`), `room_archived` (it would run in team chat, but it is still filed under an archived chat room, where no engine can see it), or `paused` (a [pause](/using/board#pause-work) covers it, or its team is archived; resuming starts it). Every refusal comes before anything is written. `room_archived` happens only for a task the archive's move to General missed; the move runs again each time Clawboo starts (see `DELETE /api/teams/:id/rooms/:roomId`). A task filed under a room that no longer exists gets `no_team`: rooms are removed only with their team, so there is no chat left to run it.

**`500 Internal Server Error`**: `{ "ok": false, "error": "<message>" }`.

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/retry \
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors'
```

---

## `POST /api/board/:taskId/assign`

Gives a task that nobody is working on to one member of its team, and starts it. Use it for a card no agent will pick up (created without one, or by an agent's own `create_task`), or to hand a failed task to someone else. The task is bound to the agent as a person's assignment (see `POST /api/board`), moved back to `todo` if it was `blocked`, `backlog` or stranded `in_progress` (no assignee and no run going), noted on its trail (`Assigned to <name>.`) and started. When the agent is not the one it was bound to, every agent's saved session on the task is cleared, so the new agent starts fresh and so does an earlier one if the task comes back to it. Assigning it to the same agent again keeps that agent's session, like a retry.

A task with `runnerInputs` starts through the task runner, on the new agent's runtime, with the saved repository and isolation kind; the saved model is kept only when the runtime is the same. An agent on a runtime the runner cannot run, such as OpenClaw, and a task with no `runnerInputs`, start in team chat. See `retry` above.

- **Path params**: `taskId`.
- **Request body**: `{ agentId: string }`.

### Responses

**`200 OK`**: `{ "ok": true, "task": DbTask }`.

**`400 Bad Request`**: `{ "ok": false, "error": "agentId required" }`, or `agent_not_in_team` (the agent is unknown, archived or on another team).

**`404 Not Found`**: `{ "ok": false, "error": "task not found" }`.

**`403 Forbidden`**: `{ "ok": false, "error": "person_only" }`: the request did not pass the person check. Nothing was written.

**`409 Conflict`**: `no_team`, `not_assignable` (the task is being worked on, finished, cancelled or dropped), or `room_archived` (as for `retry`: it would start in team chat but is still filed under an archived chat room). `no_team` also covers a task whose room went with its team. A refusal binds nothing and writes no note.

**`500 Internal Server Error`**: `{ "ok": false, "error": "<message>" }`.

### Example

```bash
curl -X POST http://localhost:18790/api/board/<task-id>/assign \
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<agent-id>"}'
```

---

## `POST /api/board/:taskId/reopen`

A person reopens a `done` or `cancelled` task: it goes back to `todo`, with `completedAt` and `personCancelledAt` cleared, and a note on its comments. A saved wake starts it, so a restart cannot lose the start or the words. With `comment`, its agent starts with those words. Without one, a task bound to an agent starts as a retry starts it. A task assigned to a person goes back to them and starts nothing, and a task with no agent waits in Needs you. A finished task's saved sessions are already cleared, so the run starts fresh. Plan steps cancelled along with it stay cancelled.

**A person's route.** It answers `403 { "ok": false, "error": "person_only" }` to a request that does not pass [the person check](/operating/security#the-person-check). A speed bump on a local install: see [What counts as a person](/operating/security#what-counts-as-a-person). The moves are not in the status table, so `PATCH /api/board/:taskId` cannot make them.

- **Request body** (optional):

```ts
{
  comment?: string // up to 20000 chars
  onThread?: boolean // the comment is a reply already saved on the task: pass it on, do not save it again
}
```

**`200 OK`**: `{ ok: true, task: DbTask, delivery?: ReplyDelivery }`. `delivery` says where a `comment` went, as on a person's comment, and is also present when a task with no comment could not start. A reopened task whose words reached no one still answers `200`: read `delivery`.

**`404 Not Found`**: no such task. **`409 Conflict`**: `{ "ok": false, "error": "not_finished" }`, or `"blocker_cancelled"` for a task that depends on one that was cancelled or dropped: nothing would ever start it, so reopen that one first.

## `POST /api/board/:taskId/assign-person`

Gives a task nobody is working on to a person. It takes any agent off it, including the agent binding, so nothing starts it and a comment reaches no agent. Whoever delegated it is still told when it finishes. Every agent's saved session on it is cleared. A `blocked` or stranded `in_progress` task goes to `todo`. Any open question closes.

**A person's route**, like `reopen`. There is no member list, and a request body never makes a person: `personId` may name only the sender or the person who asked for the task.

```ts
{
  personId?: string | null // absent: the sender. null: take the person off
}
```

**`200 OK`**: `{ ok: true, task: DbTask, attention }`. **`400 Bad Request`**: `{ "ok": false, "error": "unknown_person" }`. **`404 Not Found`**: no such task. **`409 Conflict`**: `{ "ok": false, "error": "not_assignable" }`: the task is being worked on, finished, cancelled or dropped.

## `GET /api/board/:taskId/questions`

The questions agents asked on a task, oldest first: `{ questions: DbTaskQuestion[] }`. See [`task_questions`](/reference/database-schema#task_questions).

## `POST /api/board/agent-wakes/:jobTaskId`

A person answers the card about agents waking each other on a job. Yes also starts the job's hour and the two agents' count again, which lifts a pause, and starts what was waiting. An answer to the first ask also covers the other tasks waiting on it (`alsoWaiting`). No Tasks tool can do this.

**A person's route**, like `reopen`.

- **Path param**: `jobTaskId`: the job's task, from `attention.agentWakes.jobTaskId`.
- **Request body**:

```ts
{
  decision: 'job' | 'team' | 'no' // on this job; always in this team; no on this job
}
```

**`200 OK`**: `{ ok: true, task: DbTask, attention: TaskAttention | null }`, for the task the card showed on.

**`400 Bad Request`**: a wrong body. **`404 Not Found`**: no such task. **`409 Conflict`**: `{ "ok": false, "error": "no_card" }` when no card is up or nothing waits on it any more, so a second press changes nothing, or `"no_team"` for `team` on a job with no team.

## `POST /api/board/questions/:questionId/answer`

A person answers an agent's question. The question goes on the task's comments under the agent that asked it, the answer goes there in the person's name, and the task starts again for its agent, as a person's reply starts it. No Tasks tool can do this.

**A person's route**, like `reopen`. It records the verified person, or the install's built-in one, as `answeredBy`. Behind a sign-in proxy in `required` mode, every request here also needs a verified person.

```ts
{
  answer:
    | { choice: string } // one of a question's options
    | { text: string } // free text, where the question takes it
    | { confirmed: boolean; note?: string } // a confirmation
    | { accepted: boolean; tasks?: Array<{ title: string; description?: string }>; note?: string } // suggested tasks
}
```

An answer is judged against expiry inside its own write. A question closes unanswered when its task reaches `done` or `cancelled`, is dropped or moves on, or when a newer question replaces it, and an answer that loses that race changes nothing.

**`200 OK`**: `{ ok: true, question: DbTaskQuestion, task: DbTask, delivery: ReplyDelivery }`. The answer is saved even when `delivery.status` is `not-delivered`. The task then stays Blocked, and its `attention.detail` says the answer could not start the agent. Under a [pause](/using/board#pause-work), `delivery.reason` is `paused`, the task stays Blocked, and its `attention.detail` says the agent gets the answer after the resume. **`400 Bad Request`**: `invalid_answer`, an answer this question does not allow. **`403 Forbidden`**: `person_only`. **`404 Not Found`**: `not_found`. **`409 Conflict`**: `answered`, `expired` or `cancelled`.

## `GET /api/board/:taskId`

Returns one task with its comments (oldest first) and its ancestors (the chain of parent tasks).

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`200 OK`**:

```ts
{
  task: DbTask & {
    attention
    runCost
    runningSince // shape as in GET /api/board
    // How the run working on the task takes a comment now: the run's own way,
    // which can differ from its runtime's (a Hermes run that fell back to
    // `hermes chat` stops and resumes). null when no run is registered here.
    runSteering: 'live' | 'interrupt-resume' | 'none' | null
    // A saved wake still waiting to reach the task's agent, and why it waits.
    // skipReason is null until a pump pass has seen it. held: a person's Stop holds
    // it for the task's next run. See `task_wake_skipped` for the reasons.
    pendingWake: {
      reason: string
      skipReason: string | null
      comments: number
      held: boolean
    } | null
  }
  comments: Array<{
    id: string
    taskId: string
    authorAgentId: string | null
    authorType: 'agent' | 'user' | 'system'
    body: string
    tenantId: string | null
    person: string | null // JSON { id, name, role }, when a sign-in proxy vouched for who added it
    kind: string | null // 'person' | 'agent' | 'note' | 'result': what wrote it, set by the writer
    steeredAt: number | null // when it reached a run live
    executionId: string | null // the run that wrote it, when an agent's run did
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

## `GET /api/board/inbox`

The small read behind the Inbox badge: what is unread for this reader, and what needs a person, across every team. The reader is the person a [sign-in proxy](/guides/sso-proxy) vouched for, or else one built-in reader. A person new to the proxy starts caught up.

Don't poll it. Open the [event stream](/reference/rest-api/observability) with `?activity=1`, and read this when an `activity` event says something moved.

**`200 OK`**:

```ts
{
  // Newest change first, at most 100. `seq` is the task's newest change, a position
  // in the board's history. The app's own notes and heartbeats do not make a task
  // unread, and this reader's own write marks the task read.
  unread: Array<{ id: string; seq: number }>
  // Task ids with a needs-you reason, the same ones the board's column lists, at
  // most 100.
  needsYou: string[]
  // Ids of pending approvals that have not expired.
  approvals: string[]
  // The newest change this read knew of: what "mark all read" should cover.
  through: number
}
```

Rows on `GET /api/board` and `GET /api/board/:taskId` carry the same state as `unread: boolean` and `activity: { seq, kind, at } | null`. `kind` is `created`, `status`, `edited` or `comment`. `activity` is null for a task last changed before the board kept this record.

## `POST /api/board/:taskId/read`

Mark a task read as of the change the page showed, which is what makes a change that landed since stay unread. A person's write: it takes [the person check](/operating/security#the-person-check). This is a speed bump rather than a boundary, as on comments: any program running as the same user can send the same headers.

**Request body**:

| Field     | Type    | Notes                                                                                                            |
| --------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `through` | integer | The `activity.seq` the page rendered. Clamped to the task's newest change, and a mark never moves a reader back. |

**Responses**:

| Status | Body                                 | When                                |
| ------ | ------------------------------------ | ----------------------------------- |
| `200`  | `{ ok: true, unread: boolean }`      | `unread` is whether it still is     |
| `400`  | `{ error: 'invalid body', details }` | `through` is not a whole number ≥ 0 |
| `403`  | `{ error: 'person_only' }`           | The caller is not a person          |
| `404`  | `{ error: 'task not found' }`        |                                     |

## `POST /api/board/inbox/read`

Mark everything read as of `through`, or one team's tasks. A change after `through` stays unread. The same rule on who may call it as `POST /api/board/:taskId/read`.

**Request body**:

| Field     | Type    | Notes                                                      |
| --------- | ------- | ---------------------------------------------------------- |
| `through` | integer | The newest change the page knew of. Clamped to the newest. |
| `teamId`  | string  | Optional. Leave it out for every team.                     |

**Responses**: `200 { ok: true }`, `400` for a bad body, `403 { error: 'person_only' }`.

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

**`409 Conflict`**: the task was not in a claimable state (already claimed, dropped, or not `todo`), or it is assigned to a person (`person_assigned`):

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

A `priority` of Urgent is kept only from a request that passes [the person check](/operating/security#the-person-check); any other caller stops at High. That check is a speed bump, not a boundary (see [Security](/operating/security)).

This is the route a **person** uses (the board and the task drawer), and a person's move is the final word on the task. These rules hold for a request that passes [the person check](/operating/security#the-person-check):

- A move to `done` or `cancelled` may carry `completedAt`, the day it really finished. It must fall between the task's creation and now (up to 5 minutes ahead of the server clock is allowed), else **400** `invalid_completed_at`. Without it the finish time is now. Writing the same finished status again never moves the finish time.
- A move to `cancelled` also cancels the task's pending (`todo` / `backlog`) dependents, which could otherwise never run, and returns them as `cancelledDependents`. It frees each of their places under their parent for the [Tasks tools' child cap](/reference/mcp-tools#creation-caps).
- A move to `backlog`, `todo`, `blocked`, `done` or `cancelled` stops the run working on the task, whether team chat, the task runner or an OpenClaw Routine fire started it, and closes its ledger row as cancelled. A move to `in_progress` or `in_review` stops nothing. A task moved back to `todo` while it was running is started again for its bound agent.
- Whoever delegated the task (the `:reflectTo:` agent in its `sourceDelegationId`) is told a person marked it done or cancelled it: through a `[Task Update]` when the team's engine is running, else as a mailbox notice read at its next turn. A task a person assigned reports to nobody.
- The move is stamped on the task as `personMovedAt`. Until a run starts after it, the agent's own status writes through the [tasks MCP tools](/reference/mcp-tools) (`update_task_status`, `block_task`, `unblock_task`) are refused with a tool error that names the column the person chose and tells the agent not to retry, so the run the person overruled cannot put the card back. A run that starts after the move writes as usual.

<Note>

A task with no stored check result is unchecked, not failing, and moves to `done` normally. Most tasks never get a check: only task-runner runs in a git worktree with a non-empty diff are checked (see [Verification](/concepts/verification)). Moving a task to `todo` clears its assignee and check result so it can be claimed again.

</Note>

**From any other caller**, a status change still happens, the way an agent's own move through the Tasks tools does: it is not stamped as `personMovedAt`, stops no run and tells no delegator, cannot change a task a person moved after its latest run started (**409** `person_moved`), and ignores `humanOverride`, so a failing check still refuses `done`. Its event records `actor: { kind: 'caller' }` and no `by`, and the answer carries `byPerson: false`. Field edits (`priority`, `title`, `description`) work the same from every caller and write no event.

A status change writes a `status_changed` event with the `actor` that made it, and posts `A person moved "<title>" to <Status>.` (from another caller, `A local API call moved ...`) to the team's peer room.

- **Path params**: `taskId`.
- **Request body** (at least one field required):

```ts
{
  status?: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
  priority?: number             // integer: 2 urgent, 1 high, 0 normal, -1 low; held to that range
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

**`409 Conflict`**: the status transition is illegal, the verification gate blocked `→done`, or (from a caller the person check did not let through) a person moved the task after its latest run started:

```ts
{ ok: false, error: 'illegal_transition' | 'verification_required' | 'person_moved' }
```

**`500 Internal Server Error`**:

```json
{ "error": "<message>" }
```

### Example

```bash
# Make it urgent + retitle
curl -X PATCH http://localhost:18790/api/board/<task-id> \
  -H 'Content-Type: application/json' \
  -d '{"priority":2,"title":"Updated title"}'

# Ship despite a non-promotable verdict (audited; a person's request only)
curl -X PATCH http://localhost:18790/api/board/<task-id> \
  -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' \
  -H 'Content-Type: application/json' \
  -d '{"status":"done","humanOverride":true}'
```

---

## `POST /api/board/:taskId/comments`

Adds a comment to a task (discussion or a system note). `authorType` defaults to `agent`. The route writes a `comment_added` event and posts the first 160 characters to the team's peer room. An unknown `taskId` is not checked first: the insert fails the database's foreign key and the route answers **500** (`FOREIGN KEY constraint failed`).

A `user` comment is a person's reply, and only a request that passes [the person check](/operating/security#the-person-check) can post one: the dashboard's own page, or a person a sign-in proxy vouched for. The route reads the fetch metadata a browser adds to the page's requests: `Sec-Fetch-Site: same-origin` with `Sec-Fetch-Mode: cors` or `same-origin`. From any other caller, such as `curl` or a command an agent runs, a `user` or `system` comment is saved as an `agent` comment and answers with no `delivery`: it is not delivered as your reply and starts no run. Like any comment, its first 160 characters are still posted to the team room, where the team's agents can read them. This is a speed bump, not a security boundary: a program running as you can send the same headers, or write Clawboo's database directly.

After a person's comment is saved, the route delivers it to the agent the task belongs to: the assignee, or else the agent named in the task's `sourceDelegationId` (a task moved back to `todo` keeps that binding). Nothing is delivered when there is no such agent, or when the task is `done`, `cancelled` or dropped.

1. **A saved wake**, always first, except on a `backlog` task and on a run the task runner is driving now. It is folded into the wake already waiting for that agent and task, if one is, and it holds the comment's id until a run takes it. A task the task runner runs also gets a mailbox note, `A person commented on your task "<title>": ...`, with the comment's first 1000 characters: it has no ticket block.
2. **Then by status:**
   - `in_progress` with a run working on it: a steer into that run, with comments sent within a second of each other going in as one. How it gets in depends on the runtime (see [Choose a runtime](/runtimes/index)). The route waits up to 2.5 seconds for the steer to land, and the steer carries on in the background after that. When it lands whole, that run carries the comment, and it counts as heard when the run ends well; a run that dies gives it back. When it does not land, or does not fit (1,000 characters, with a cut marker that names `get_task`), the comment rides the task's next turn: on team chat work, the agent answers it before the task can be `done`.
   - `blocked`, `todo`, or `in_progress` with no assignee and no run going: the task is started again, as the retry route above does. A task that is not `todo` moves there first (with a `status_changed` event whose reason is `reply`). If every task it depends on is `done`, the route adds the `system` comment `Started again for a person’s reply.` and dispatches the task to its agent; otherwise the reply waits with the wake. A `todo` task whose reply folded into a wake a run is already on its way for is not dispatched again; a wake that was held, replaying or not a person's starts it now. While the engine is held, nothing moves or starts, and the reply answers `queued`, `held`.
   - `in_review`: the reply waits with the wake, and the agent reads it in its next turn, whatever the check answers.
   - `backlog`: nothing starts, and the agent reads the comment in its ticket block when the task next runs.

A task with no team, or one whose move back to `todo` is refused, is not started again: the reply waits for its next run. A reply that would start the task again in team chat (a `blocked` or `todo` task, or a stranded `in_progress` one) is not delivered when the task is still filed under an archived chat room (`not-delivered`, `room_archived`), or under a room that went with its team (`no_team`). The comment stays saved, and the task is left as it was with nothing written for the reply.

- **Path params**: `taskId`.
- **Request body**:

```ts
{
  body: string                          // required, 1 to 20000 chars
  authorAgentId?: string
  authorType?: 'agent' | 'user' | 'system'   // default 'agent'; 'user' and 'system' only past the person check
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
    person: string | null // JSON { id, name, role }, when a sign-in proxy vouched for who added it
    kind: string | null // 'person' for a comment that passed the person check, else null
    steeredAt: number | null
    executionId: string | null // the run that wrote it, when an agent's run did
    createdAt: number
  }
  forwarded: boolean // true when `delivery` is present and its status is not 'not-delivered'
  delivery?: // present for a `user` comment only
    | { status: 'steered'; agentId: string }
    | { status: 'woke-agent'; agentId: string }
    | { status: 'queued'; agentId: string; reason: 'next-run' | 'in-review' | 'waiting' | 'held' | 'paused' }
    | {
        status: 'not-delivered'
        agentId: string | null
        reason: 'finished' | 'unassigned' | 'failed' | 'room_archived' | 'no_team'
      }
}
```

`delivery` says where a person's reply went. `agentId` is the agent the task belongs to.

| `status`        | `reason`        | Meaning                                                                                                                                                                                                     |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steered`       |                 | The reply got into the run working on the task                                                                                                                                                              |
| `woke-agent`    |                 | The task was started again for the reply, or the reply folded into a wake already on its way                                                                                                                |
| `queued`        | `next-run`      | The agent reads it at its next turn: a `backlog` task, or an `in_progress` task whose steer did not land within 2.5 seconds. On a team chat task it is a saved wake, answered before the task can be `done` |
| `queued`        | `in-review`     | The task is `in_review`; the agent reads the reply in its next turn, whatever the check answers                                                                                                             |
| `queued`        | `waiting`       | The task waits on a dependency that is not `done`, so it cannot start yet                                                                                                                                   |
| `queued`        | `paused`        | A pause covers the task, so nothing starts. The task stays where it is, and the wake goes out on resume, on a blocked, parked or stopped task too                                                           |
| `queued`        | `held`          | The engine is held, so nothing starts. The task stays where it is, and the wake goes out when the hold lifts                                                                                                |
| `not-delivered` | `finished`      | The task is `done`, `cancelled` or dropped. The comment is saved and nothing is sent                                                                                                                        |
| `not-delivered` | `unassigned`    | No agent has the task, and `agentId` is `null`                                                                                                                                                              |
| `not-delivered` | `failed`        | Saving the wake or starting the task failed. The comment is saved, and the route still answers `200` so the reply is not sent twice                                                                         |
| `not-delivered` | `room_archived` | The task would start in team chat but is still filed under an archived chat room, so nothing could run it. The comment is saved and nothing is sent                                                         |
| `not-delivered` | `no_team`       | The task would start in team chat but its room went with its team, so no chat is left to run it. The comment is saved and nothing is sent                                                                   |

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

# From curl, "authorType":"user" is saved as an agent comment, not delivered as your reply.
# A person's reply comes from the task drawer.
curl -X POST http://localhost:18790/api/board/<task-id>/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Use the v2 schema; it landed this morning.","authorType":"user"}'
```

---

## `PUT /api/board/:taskId/labels`

Replaces the task's labels with this set, all from its own team. A person's call: a request that does not pass [the person check](/operating/security#the-person-check) gets **403** `person_only`. That check is a speed bump, not a boundary. The change goes on the [audit feed](/reference/rest-api/governance) as a `board` event, with its `actor` and the person a sign-in proxy vouched for.

- **Path params**: `taskId`.
- **Request body**: `{ labelIds: string[] }`. At most 10.

### Responses

**`200 OK`**: `{ labels: Array<{ id: string; name: string }> }`.

**`400 Bad Request`**: the body failed validation.

**`403 Forbidden`**: `{ "error": "person_only" }`.

**`404 Not Found`**: `{ "error": "not_found" }`, no such task.

**`409 Conflict`**: `{ "error": "label_not_in_team" }` (a label of another team, or any label on a task with no team) or `{ "error": "too_many" }`.

---

## `POST /api/board/:taskId/executions`

Opens a row in the task's run ledger, after a successful claim. The server reads the ledger after a restart to find runs that died: a worker that starts work must open a row here and close it with the `PATCH` below. A row left open by a crash is marked `failed` and its task released. A new row writes an `execution_started` event.

A new run is what ends a person's hold on a card (see `PATCH` above), so while a person's move stands, a caller that does not pass the person check gets **409** `{ "ok": false, "error": "person_moved" }` and no row is opened.

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

The task `kind` decides whether a worktree is made: `code` (the default) and any unknown kind get one; `research` and `review` are refused with **422**. Asking again for a task that already has a live worktree reuses it and returns the path the task records for it.

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

**`409 Conflict`**: a folder is already at the task's worktree path and replacing it could lose work, because it has uncommitted changes or git cannot read it. The folder is left as it is:

```ts
{ ok: false, error: 'unsafe_to_rebuild', worktreePath: string, message: string }
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

Pauses or completes a task's worktree: the checkout the task records, which has to be the task's folder under `<clawboo home>/worktrees/<repo hash>/` or the work folder's `worktrees/<repo hash>/` (see [The work folder](/operating/data-and-state#the-work-folder)). A recorded path anywhere else answers **500** with `Error: worktree path does not belong to task <taskId>: <path>`, and nothing is removed.

- **`pause`**: commits any uncommitted work, removes the worktree and keeps the branch. The workspace stays `active` and can be resumed.
- **`complete`** with an empty diff: removes the worktree and branch and moves the task to `done`. A task in `todo` (released by a pause, or never claimed) moves through `in_progress` first; a `blocked` task stays `blocked`. There is nothing to check, so the check is skipped. The task files do not count toward the diff, so a run that only updated its own progress or handoff is still empty.
- **`complete`** with a non-empty diff: moves the task to `in_review` and runs the check, through `in_progress` when it is in `todo`. Only a `pass` moves it to `done`. A `fail` with attempts left moves it back to `in_progress`. A `fail` on the last attempt, or `completed_with_debt`, moves it to `blocked` with a system comment and a mailbox notice to whoever delegated it. A repeat `complete` on a `blocked` task does not run the check again; it returns the current status with `verified: 'fail'`.

Through this route the check is the task's own verify command only; the separate reviewer pass never runs. The command is the team's verify command when the team has one (see the [Teams API](/reference/rest-api/teams)), else `VERIFY_CMD` in the worktree's `init.sh` (else the `Verify:` line in `VERIFICATION.md`). Without a team command the task files start with a placeholder command, which counts as no command, so the check fails until a real one is set. If a person moves the task to `done` or `cancelled` while the check runs, their move stands and the result is only recorded. See [Verification](/concepts/verification).

`complete` takes [the person check](/operating/security#the-person-check), because it moves the card and on an empty diff can pass a failing check: any other caller gets **403** `person_only` and nothing changes. A move it makes writes a `status_changed` event with reason `workspace_complete` and the `actor`, except a move to `blocked`, which writes its own. `pause` moves no card and takes no check.

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
  superseded?: true             // someone moved the task while it was checked, so the verdict moved nothing
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

The task drawer's workspace view: the contents of the task files that exist (`TASK.md`, `task-progress.md`, `DECISIONS.json`, `init.sh`, `VERIFICATION.md`, `AGENT_HANDOFF.json`), plus the unified diff and diff stats against the starting commit, with the task files left out of the diff. The files are read the way the [workspace file view](#the-workspace-file-view) reads one, up to 256 KB each, so a task file that is a symbolic link, or that is not text, is left out, and a longer one holds only its first 256 KB and is named in `sorFilesTruncated`.

- **Path params**: `taskId`.
- **Request body**: none.

### Responses

**`404 Not Found`**: no task with that id:

```json
{ "error": "task not found" }
```

**`200 OK`** with `ok: false`: the task exists but has no checkout of its own (no workspace row, or one with no worktree path). Most tasks never get one, so this is the ordinary answer for them:

```json
{ "ok": false, "reason": "no_workspace" }
```

**`200 OK`**: the task files and the diff (`diffStat` and `diff` are empty when the worktree is paused or git is unavailable):

```ts
{
  ok: true
  workspace: DbWorkspace        // shape as in GET .../workspace
  sorFiles: Record<string, string>   // task file contents, keyed by file name
  sorFilesTruncated: string[]        // names of the files cut at 256 KB
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

The worktree path comes from the stored workspace row, never from the request. Every relative path is kept inside the worktree in three ways: absolute paths and `..` segments are refused; the resolved path must sit inside the root (so a sibling such as `<root>-evil` cannot pass as `<root>`); and symlinks are refused outright, with the path checked again after resolving any symlinked parent folder. The agent can change the worktree while it is read, so a file is opened without following a link, and checked again after the open: its path must still resolve to itself and name the same file, with one name. A file or folder swapped for a link after the first check is refused too. On Linux the check after the open also asks the kernel where the open file is, which a folder swapped back and forth during the check cannot fool; on macOS and Windows that last case is a race the server can lose. A file with more than one hard link is refused as well, since a hard link can give a file outside the worktree a name inside it; a git checkout never makes one, though a package manager's store can. Backslashes, control characters and paths over 1024 characters are refused too. A refused path answers **400** `{ "ok": false, "error": "<what is wrong>" }`.

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
- Paths follow the same rules as the [workspace file view](#the-workspace-file-view): no `..`, symlinks, hard-linked files, backslashes or control characters, and at most 1024 characters. Leading slashes are dropped, so `preview//index.html` is the worktree's `index.html`, never a path from the root of the disk.
- `Content-Type` comes from a fixed list: `html`/`htm`, `css`, `js`/`mjs`, `json`/`map`, `txt` and `md` (as `text/plain`), `svg`, `png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `ico`, `woff`/`woff2`, `ttf`, `otf`, `mp4`, `webm`, `wasm`. Anything else is sent as `application/octet-stream`, which a browser downloads rather than runs.
- Every file is sent with `Content-Length`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and streamed.
- Every response, redirects and errors included, carries `Content-Security-Policy: sandbox allow-same-origin`.
- The routes sit under `/api`, so the same-origin guard and the access gate apply, and the dashboard's access cookie reaches the preview frame.

The page is served from the dashboard's own origin, so a script in it could call this API as you. No script runs: the drawer shows the page in a frame sandboxed with `allow-same-origin` only, and the `Content-Security-Policy` header applies the same sandbox when the **Open** link, or anyone with the URL, loads the page in a tab of its own. Styles and images load, and a script-driven page appears as its static shell. `allow-same-origin` stays because without it the page's own requests for its styles and images count as cross-site, and the same-origin guard refuses them.

### Responses

**`200 OK`**: the file's bytes.

**`302 Found`**: a folder requested without a trailing slash.

**`400 Bad Request`**: a refused path, or a missing file. The message names the problem, for example:

```json
{ "ok": false, "error": "No such file in the workspace." }
```

**`404 Not Found`**: `{ "ok": false, "error": "<message>" }`, where the message is `workspace not_found` or `workspace gone` (no usable worktree), `No index.html in that directory.`, or `Not a file.`

**`413 Payload Too Large`**: a file over 8 MB: `{ "ok": false, "error": "That file is too large to preview." }`

**`500 Internal Server Error`**: `{ "error": "<message>" }`, including when a file that is there cannot be opened (no permission, no file descriptors left), or `preview read failed` when reading it fails partway.

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
- `{ "ok": false, "error": "<reason>" }` comes from: the claim (`not_found`, `conflict`); a status change on `PATCH /api/board/:taskId` (`not_found`, `illegal_transition`, `verification_required`, and `invalid_completed_at` as a `400`); every retry and assign failure (`task not found`, `agentId required`, `not_retryable`, `no_team`, `unassigned`, `agent_not_in_team`, `not_assignable`, `room_archived`); the dependency cycle (`409 task_dependency_cycle`); the provision route (`task not found`, and `no_isolation` with `isolation`); and the pause, complete and handoff `404`s (`workspace not found`).
- The workspace file view adds `reason` to its misses and answers a refused path with `{ "ok": false, "error": "<message>" }`.
- The preview routes answer `{ "ok": false, "error": "<message>" }` on `400`, `404` and `413`.
- `GET /api/board/:taskId/workspace` answers a missing workspace with a bare `{ "error": "workspace not found" }`. `/workspace/detail` answers a task without one with `200` and `{ "ok": false, "reason": "no_workspace" }`, and an unknown task with `404` and `{ "error": "task not found" }`.

An unknown `taskId` on a comment, or an unknown `parentTaskId` on a create, is a `500` from the database's foreign key, not a `404`.

## Related

- [The board](/concepts/the-board): statuses, claims, dependencies and how stuck tasks are recovered.
- [Worktrees and handoff](/concepts/worktrees-and-handoff): the task files and `AGENT_HANDOFF.json` across runtimes.
- [Verification](/concepts/verification): which tasks are checked, and what `completed_with_debt` means.
- [Runtimes API](/reference/rest-api/runtimes): `POST /api/runtimes/:id/run` claims one of these tasks and runs it.
- [Database schema](/reference/database-schema): the `tasks`, `task_deps`, `task_comments`, `workspaces` and `execution_processes` tables.
