---
title: 'MCP tools reference'
sidebarTitle: 'MCP tools'
description: 'Every tool on the Tasks, Memory, Tools and TeamChat MCP servers, with arguments, results, errors and what each kind of caller is served.'
keywords:
  [
    'mcp',
    'clawboo-tasks',
    'clawboo-memory',
    'clawboo-tools',
    'clawboo-teamchat',
    'read_tool_result',
    'team_delegate',
    'scopeSig',
    'attachToken',
  ]
---

Clawboo hosts four MCP servers. Agents on every runtime use them to read and update the shared board, save and recall memory, call brokered tools, and talk in their peer room. This page lists every tool with its arguments, results and errors, and explains which tools each kind of caller is served and what it can see.

To attach an agent of your own, follow [Attaching Clawboo's MCP servers](/operating/mcp-servers). For the HTTP routes behind the servers, see the [Tools and MCP API](/reference/rest-api/tools-and-mcp).

## Servers

| Server                       | Name in `tools/list` | Tools                                                             | What it fronts                        |
| ---------------------------- | -------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| [Tasks](#tasks-server)       | `clawboo-tasks`      | 12                                                                | The [board](/concepts/the-board)      |
| [Memory](#memory-server)     | `clawboo-memory`     | 4                                                                 | Shared [memory](/concepts/memory)     |
| [Tools](#tools-server)       | `clawboo-tools`      | Visible builtins, granted connector tools, and `read_tool_result` | The tool broker (approvals and audit) |
| [TeamChat](#teamchat-server) | `clawboo-teamchat`   | 2, plus `team_delegate` on orchestrated team runs                 | The agents' peer room                 |

Every server reports version `0.1.0` and declares the `tools.listChanged` capability. Only the Tools server sends list-changed notifications, when a connector connects or disconnects.

## Tool index

| Tool                                          | Server   | What it does                                             |
| --------------------------------------------- | -------- | -------------------------------------------------------- |
| [`list_tasks`](#list_tasks)                   | Tasks    | List tasks, or only the ones ready to claim              |
| [`get_task`](#get_task)                       | Tasks    | Read one task with its comments and parent chain         |
| [`create_task`](#create_task)                 | Tasks    | Create a root task or a subtask                          |
| [`create_subtask`](#create_subtask)           | Tasks    | Create a subtask under a parent                          |
| [`claim_task`](#claim_task)                   | Tasks    | Atomically claim a `todo` task                           |
| [`assign_task`](#assign_task)                 | Tasks    | Atomically hand a `todo` task to an agent                |
| [`release_task`](#release_task)               | Tasks    | Put an `in_progress` task back to `todo`                 |
| [`update_task_status`](#update_task_status)   | Tasks    | Move a task to another status                            |
| [`block_task`](#block_task)                   | Tasks    | Move a task to `blocked`, saying what it waits on        |
| [`ask_person`](#ask_person)                   | Tasks    | Ask a person about the run's task, then stop             |
| [`hand_back_task`](#hand_back_task)           | Tasks    | Hand the run's task back to the person who asked         |
| [`unblock_task`](#unblock_task)               | Tasks    | Move a task back to `todo`                               |
| [`add_comment`](#add_comment)                 | Tasks    | Comment on a task                                        |
| [`link_task`](#link_task)                     | Tasks    | Make one task wait for another                           |
| [`memory_save`](#memory_save)                 | Memory   | Save a fact or a new version of a procedure              |
| [`memory_search`](#memory_search)             | Memory   | Search facts by keyword, meaning, or both                |
| [`memory_browse`](#memory_browse)             | Memory   | List the most recently updated facts                     |
| [`memory_feedback`](#memory_feedback)         | Memory   | Report whether a recalled fact helped                    |
| [`echo`, `note`](#builtin-tools)              | Tools    | Simple builtins that exercise the broker and audit       |
| [Connector tools](#connector-tools)           | Tools    | Tools from connectors the agent has been granted         |
| [`read_tool_result`](#read_tool_result)       | Tools    | Page through a result that was too large to return whole |
| [`team_chat_post`](#team_chat_post)           | TeamChat | Post to the peer room as a named teammate                |
| [`team_chat_subscribe`](#team_chat_subscribe) | TeamChat | Read new peer-room posts since a cursor                  |
| [`team_delegate`](#team_delegate)             | TeamChat | Hand work to a teammate by name (orchestrated runs only) |

## Callers and scoping

A caller's identity decides which tools it is served and what those tools can see. Over HTTP, a session reads its identity once, when it sends `initialize`, from query parameters on its attach URL. Clawboo signs those parameters with a secret kept in its own database, so an identity counts only when its signature verifies.

There are four kinds of caller:

- **Bound caller.** A run Clawboo started with a signed attach URL. Claude Code, Codex and Hermes runs are bound to their team and agent this way. Clawboo Native agents are bound in-process. A run the team engine drives (a team chat turn, a hand-off, a plan step) is also signed as a **team run** (`teamRun=1` on its Tasks, Memory and Tools URLs, so none of them carries a plain signature for its team and agent), because the engine claims and moves that run's tasks itself. A Clawboo Native team run gets the same limit in-process. A run on a board task (a hand-off, a task you gave from the Board, or a task-runner run) also has that task on its Tasks and Tools URLs, as `scopeTaskId` inside the same signature, so a runtime cannot point it at another task; Clawboo Native gets it in-process. Its one-task tools use it when a call leaves out `taskId` (see [Tasks server](#tasks-server)), and an approval its connector calls open names it. Such a run's Tasks URL also carries its run, as `scopeExecutionId` inside the signature, which its writes record (see [Who made a write](#who-made-a-write)).
- **Unverified HTTP caller.** Any HTTP session without a valid signature. Every OpenClaw agent is one, because the OpenClaw Gateway uses one shared configuration for all of its agents. So is an external agent attached with an unscoped URL, or with parameters edited by hand.
- **Operator (stdio bin).** Someone ran a `clawboo-mcp-*` bin directly. The operator is trusted, so scope and identity come from the tool arguments.
- **In-process (Clawboo Native).** The servers run inside the dashboard server and are bound to the run's team and agent.

| Server   | Bound caller                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Unverified HTTP caller                                                                                                   | Operator (stdio bin)                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Tasks    | 12 tools. When the run has a team, reads and writes are limited to its tasks and new tasks land in it. Mailbox notices ride along on results. A team run gets 7: no `claim_task`, `assign_task`, `release_task`, `update_task_status` or `unblock_task`, and `block_task` only for its own task. A team run on a board task also gets `ask_person` and `hand_back_task`; a Clawboo Native team run whose Tasks access is read gets the two reads and `ask_person` | 6 tools: no claims and no status writes. Board-wide. Comments post as a plain `agent` comment                            | 12 tools, board-wide                                |
| Memory   | Saves are shared with the team. Reads see team facts, this agent's own facts and facts that belong to no team. Provenance is recorded                                                                                                                                                                                                                                                                                                                             | Saves and reads use only facts that belong to no team. No reporter or provenance is recorded                             | Scope comes from `scopeTeamId` and `scopeAgentId`   |
| Tools    | Builtins plus the connector tools this agent's grants allow                                                                                                                                                                                                                                                                                                                                                                                                       | Builtins and `read_tool_result`, plus any connector tools a `global` grant allows. Agent and team grants cannot be found | Builtins and `read_tool_result`; no connector tools |
| TeamChat | 2 tools, posting as the bound agent in its peer room. `team_delegate` too on orchestrated runs                                                                                                                                                                                                                                                                                                                                                                    | No tools                                                                                                                 | 2 tools; author and team come from the arguments    |

<Warning>

An attach URL you assemble by hand binds nothing. Unsigned or edited scope parameters are ignored and the session is served as an unverified caller. To give an external agent an identity, copy a signed URL from `GET /api/mcp/config` with `scopeTeamId` and `scopeAgentId` set. A scoped session for an existing agent also consumes that agent's mailbox notices.

</Warning>

### What each runtime attaches

| Runtime                    | Servers                                                                | Caller kind                                    |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Clawboo Native             | Tasks (read-only by default), Memory, Tools, and TeamChat on team runs | In-process, bound to the run's team and agent  |
| Claude Code, Codex, Hermes | All four, over HTTP                                                    | Bound, with a signed team and agent scope      |
| OpenClaw                   | Tasks, Memory and Tools, over HTTP (never TeamChat)                    | Unverified                                     |
| An agent you attach        | Whatever you configure                                                 | Unverified unless you use a signed, scoped URL |

A Clawboo Native agent's tool settings choose which servers it gets. The default is the read-only Tasks surface (`list_tasks` and `get_task`), Memory, Tools and TeamChat, because the team engine owns board writes on team runs. An OpenClaw agent takes part in the peer room through the server instead of the TeamChat tools. The critic run that [verification](/concepts/verification) can start attaches with no scope, so it is an unverified caller too.

### Attach URL parameters

| Server   | Identity parameters                                                                                             | Signed by                                      |
| -------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Tasks    | `scopeTeamId` limits reads and writes to the team; `scopeAgentId` turns on mailbox delivery                     | `scopeSig`                                     |
| Memory   | `scopeTeamId`, `scopeAgentId`, `scopeTenantId`; provenance stamps `provRuntime`, `provTaskId`, `provSessionKey` | `scopeSig`; the provenance stamps by `provSig` |
| Tools    | `scopeTeamId`, `scopeAgentId` (decide which connector grants apply), `scopeTaskId` (named on approvals)         | `scopeSig`                                     |
| TeamChat | `roomTeamId` (the room is `team:<roomTeamId>`), `postAuthorAgentId`, and `delegate=1` on orchestrated runs      | `scopeSig`, which also covers `delegate`       |

- `scopeSig` is an HMAC-SHA256 over the team, agent, tenant and delegate fields, and the team-run mark, `scopeTaskId` and `scopeExecutionId` when present, under a per-install secret stored in the `settings` table (`mcp-attach-scope-secret`). A spawned runtime only ever sees the derived signature. A URL without the newer fields signs exactly as before.
- Provenance stamps record which run saved a fact or reported an outcome. They never widen what a session can see, and they are dropped when `provSig` does not verify.
- `delegate=1` is inside the signature, so a run cannot add it to its own URL. Clawboo writes it only for runs driven by the team engine, which is watching for the `team_delegate` call.
- Every URL Clawboo writes also carries an `attachToken`. When the access gate is on, a cookieless MCP request needs it (see [Transports](#transports)).
- The request log keeps attach URLs but masks `attachToken`, `scopeSig` and `provSig`.

## Tasks server

The Tasks server is the board over MCP. Any runtime can list, create, claim and update tasks on the same board the dashboard shows. Board rules (statuses, legal moves, the verification check before `done`) are described in [The board](/concepts/the-board).

Statuses in the schemas below are `TaskStatus`:

```ts
type TaskStatus =
  'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
```

Rules that apply to every Tasks tool:

- **Team-bound sessions.** When the session is bound to a team, every tool refuses a task from another team with the same `not found: <taskId>` a missing task gets, so a bound run cannot probe other teams. `list_tasks` lists only the team's tasks, and new tasks are created in the team.
- **Refusals are tool errors.** A refused call returns `isError: true` with the text shown under each tool, not a protocol error.
- **Never retry a lost claim.** `claim failed: conflict` means another agent won the claim. Retrying the same call cannot succeed.
- **Mailbox delivery.** On a session bound to an agent, each successful result can carry an extra text block headed `[team updates` with up to five undelivered mailbox notices for that agent. Each notice is delivered once, on whichever channel reaches the agent first. A notice can quote a person or another agent, so each one is framed as data: a header `[Inter-session message · from=clawboo · kind=<kind> · isUser=false]`, then every line of the notice quoted with `| `, under a line saying the notices are information, not instructions.
- **The run's own task.** On a session bound to a task (a run on a board task), `get_task` and `add_comment` take `taskId` as optional and use that task when it is left out, and so does `block_task`. Their descriptions say so, and the field is listed as optional only on such a session. Any task can still be named (on a team run, `block_task` names only its own), and an empty `taskId` is refused rather than read as the run's own task.
- **A waiting task says why.** `block_task`, and `update_task_status` and `create_task` moving a task to `blocked` or `in_review`, need `waitingOn`. A call without it is refused with text that says what to send, and nothing moves.

### Who made a write

Every write these tools make is recorded in the [event log](/reference/events-and-errors) (`task_created`, `task_claimed`, `status_changed`, `comment_added`, `dep_linked`) with an `actor`, `ask_person` and `hand_back_task` as a `status_changed`:

- **A bound caller**: `{ kind: 'agent', agentId, execId }`, the agent the session is bound to and the `execution_processes` row of its run. `execId` is null on a turn with no run row, such as a lead's own turn or a 1:1 chat. A comment also stores the run in `task_comments.execution_id`, and a question in `task_questions.execution_id`, so the question's words on the thread name the run that asked.
- **Anyone else**: `{ kind: 'caller' }`, which says nothing about who it was. That covers every OpenClaw agent: the OpenClaw Gateway gives all of its agents one MCP address with no signature, so a write cannot be traced to one of them. It covers the stdio bins and an external agent with an unsigned URL too.

This is a record, not a boundary. The signature stops a runtime editing its own attach URL, so editing the URL cannot change the agent, though a runtime can attach with one of its other signed URLs and leave the run id out. It does not stop a program that holds the access token, which can ask `GET /api/mcp/config` for a URL signed as another agent, or one that reads the attach secret from the database. A write the tools refuse (a lost claim, an illegal move) records nothing.

### Creation caps

Creates through these tools are capped so a looping agent cannot flood the board. The caps count every task on the board, including tasks created through the dashboard, the API or the team engine, which are not capped themselves.

| Cap                 | Limit                                                                                                          | Tool error                                                                                                                                                                                                         | `_meta.denied`     |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Children per parent | 24 live (not dropped) subtasks; `done` ones and ones an agent cancelled count; a person's cancel frees a place | `subtask rejected: parent <id> already has <n> children (max 24). Finished and cancelled children still count, and only a person cancelling one frees a place. Attach the new task elsewhere, or tell the person.` | `child_cap`        |
| Nesting depth       | 2 levels below a root task (root, child, grandchild)                                                           | `subtask rejected: parent <id> is at the maximum nesting depth (2); attach the new task higher in the tree`                                                                                                        | `depth_cap`        |
| Root tasks          | 30 new root tasks per rolling 5 minutes                                                                        | `task rejected: <n> root tasks already created in the last 5 min (max 30); attach this work to an existing task with parentTaskId instead of opening another`                                                      | `root_rate_cap`    |
| Missing parent      | The parent must exist                                                                                          | `parent not found: <id>`                                                                                                                                                                                           | `parent_not_found` |

The check and the insert run in one write transaction, so two runtimes racing for the last slot cannot both get it. An unchanged retry that would make a new task gets the same answer; a person cancelling a child, or dropping a stale one, frees a slot, and the root window rolls. A refusal also carries its reason in the result's `_meta.denied` field. Clawboo Native turns that field into a `policy_denied` error, and repeated identical refusals in a task-runner run trip the circuit breaker (see [Governance](/concepts/governance)).

### A task is made once

`create_task` and `create_subtask` return an existing task instead of making a second one in two cases. The row comes back with `deduplicated: true`, `deduplicatedBy` (`key` or `title`) and a `note` naming the task, and the model should work with that task. Neither case is an error, and both come before the caps, so a repeat is never refused.

- **The same key.** `idempotencyKey` names a create, for this caller, this title and this parent: the run's own task if it has one, else the agent, else the team. The same key from the same caller with the same title and parent returns the same task, whatever became of it. A different caller, title or parent is a different create. A call with no key gets one from the run's own task, the parent and the title, which holds for 48 hours and does not match a blocked task, so a retry of failed work makes a new one. A caller with no bound task (an OpenClaw session, a lead's chat turn) gets one from the team, the parent and the title, which also does not match a finished or cancelled task: it speaks for every teammate, so an old task is not what a new create is asking for.
- **The same words.** An open task (`backlog`, `todo`, `in_progress` or `in_review`) with the same title under the same parent, team and chat room, made in the last 48 hours, is returned. Case, spacing and surrounding punctuation do not count. A blocked task is not open here, and neither is a `todo` task that will not start by itself. A task a person makes on the board can be returned too, but a person's own create never goes through this check.

### Readable ids

Every argument that names a task (`taskId`, `parentTaskId`, `dependsOnTaskId`) takes the task's id or its readable id, like `MAR-12`, in either case. Task rows carry it as `identifier`; it is null for a task with no team. A session bound to a team resolves only that team's ids: another team's readable id answers `not found`, the same as one that does not exist.

### list_tasks

List tasks, most recently updated first. Dropped (soft-deleted) tasks are left out.

```ts
{ teamId?: string; status?: TaskStatus; ready?: boolean }
```

- `ready: true` lists only tasks ready to claim: `todo`, not dropped, and every dependency `done`, highest `priority` first. `status` is ignored then.
- On a team-bound session the session's team is used and `teamId` is ignored. Otherwise a call with no `teamId` lists every team's tasks.
- Returns a JSON array of task rows (the [`tasks` table](/reference/database-schema#tasks)).

### get_task

Read one task with its comments and its ancestor chain.

```ts
{
  taskId: string
}
```

- `taskId` is optional on a session bound to a task, and defaults to it.
- Returns `{ task, comments, ancestors }`.
- Error: `not found: <taskId>` for a missing task or one outside the session's team.

### create_task

Create a task. With `parentTaskId` it is a subtask and the per-parent caps apply. Without one it is a root task and the root rate cap applies (see [Creation caps](#creation-caps)).

```ts
{
  title: string
  description?: string
  status?: TaskStatus // default 'todo'
  priority?: number // 1 high, 0 normal (default), -1 low; held to that range. Only a person sets urgent
  teamId?: string
  parentTaskId?: string // non-empty when present
  assigneeRuntime?: string
  idempotencyKey?: string // 1 to 200 characters; see "A task is made once"
}
```

- A subtask takes its parent's team and chat room.
- On a team-bound session the task is created in the session's team and `teamId` is ignored. A parent outside the team is refused with `not found: <parentTaskId>`.
- An empty `parentTaskId` fails argument validation (`invalid args: ...`); it is never treated as a root task.
- Returns the new task row, the task that was already there (see [A task is made once](#a-task-is-made-once)), or one of the cap errors.

### create_subtask

Create a subtask under a parent. It takes the parent's team and chat room, and starts in `todo`.

```ts
{ parentTaskId: string; title: string; description?: string; idempotencyKey?: string }
```

- Same caps and errors as a `create_task` with `parentTaskId`, including the team-bound parent check.
- Returns the new task row, or the task that was already there (see [A task is made once](#a-task-is-made-once)).

### claim_task

Claim a `todo` task for an agent. The claim is atomic: when two agents race, exactly one wins. The claimed task moves to `in_progress` with the assignee set.

```ts
{ taskId: string; assigneeAgentId?: string; assigneeRuntime?: string }
```

- A caller bound to an agent claims for itself: `assigneeAgentId` is optional, and naming another agent is refused with `claim_task claims a task for you (<agent>), not for <name>. To hand a task to another agent, use assign_task.` The operator's stdio bin names the agent, as before.
- Succeeds only for a task that is `todo`, has no assignee and is not dropped.
- Returns the claimed task row.
- Errors: `claim failed: conflict` (the task exists but is not claimable, for example another agent won; do not retry), `claim failed: paused` (a person paused the agent, the team or the task's tree, or the team is archived; do not retry), `claim failed: not_found`, and `not found: <taskId>` for a task outside the session's team.
- Not served to an unverified HTTP caller, because `assigneeAgentId` would let it act as any agent, nor on a team run, where the engine claims each task for its agent.

### assign_task

Hand a `todo` task to an agent. It is the same atomic claim as `claim_task`, with the same results and errors, and `assigneeAgentId` is always required; `conflict` means the task is already taken, and a task assigned to a person is refused the same way. Not served to an unverified HTTP caller or on a team run.

A hand-off cannot go in a circle. It is refused with `Not handed off: ...` (typed `hand_off_cycle` in `_meta.denied`) when the target handed out the task or any of its open ancestors, unless the target is the team's lead or Boo Zero. Assigning to yourself is not a hand-off. A bound caller is recorded as the task's delegator, and so is a bound caller that creates it.

### release_task

Put an `in_progress` task back to `todo` and clear its assignee and its verification verdict, so another agent can claim it.

```ts
{
  taskId: string
}
```

- Returns the text `released: <taskId>`. A task that is not `in_progress` is left unchanged, and the same text is returned.
- Not served to an unverified HTTP caller or on a team run.

### update_task_status

Move a task to another status. Legal moves follow the board's state machine; `done` and `cancelled` are final, and setting the current status again is a harmless no-op.

```ts
{
  taskId: string
  status: TaskStatus
  // Required for blocked and in_review. See block_task.
  waitingOn?: 'person' | 'task' | 'subtasks'
  need?: string
  waitingOnTaskId?: string
}
```

- Moving a task to `todo` also clears its assignee and its verification verdict.
- Moving a task to `cancelled` also cancels the plan steps still waiting on it (`todo` or `backlog`, all the way down the chain), as a person's cancel on the board does. The result then carries them as `cancelledDependents: [{ id, title }]`. Cancelling a task that is already cancelled runs the same cascade again, so a repeated call finishes one an earlier call left undone. The agent that delegated the task gets a mailbox note naming it and how many steps went with it, unless that agent made the call. When the note cannot be written, the cancel still stands and the result carries `delegatorNotTold: <agentId>`.
- Returns the updated task row.
- Errors: `status change failed: illegal_transition`, `status change failed: not_found`, and `status change failed: verification_required` when the task holds a failing verification verdict (only a person's override, from the board or the board API, can finish it). See [When work is checked](/concepts/verification).
- Refused for a task assigned to a person, and for one waiting on a person's answer to a question: the tool errors start `This task is assigned to a person` and `This task is waiting for a person to answer a question`. This holds on every status tool, for any agent.
- Refused when a person moved the card on the board or in the task drawer after the task's latest run started (or the task has not run since): that run was overruled, and the status stays where the person put it. The tool error reads `A person moved this task to <column> after your run on it started, so its status is theirs to set. Leave it as it is and do not retry this call.` A run started after the move writes as usual.
- Not served to an unverified HTTP caller or on a team run. On a team run the engine moves the card when the run ends and reports the result to whoever handed out the task.

### block_task

Move a task to `blocked`, saying what it waits on. It is `update_task_status` with `status: 'blocked'`.

```ts
{
  taskId: string
  waitingOn: 'person' | 'task' | 'subtasks' // required
  need?: string // for 'person': what the person must do
  waitingOnTaskId?: string // for 'task': the task that must finish first
}
```

- `taskId` is optional on a session bound to a task (a team run or a task runner run), and defaults to it. Elsewhere it is required.
- `waitingOn` is listed as required, and a call without it is refused. `update_task_status` to `in_review` takes only `person`, because a wait on other work can end only from `blocked`. `person` needs `need` and shows in Needs you with that text. `task` must name an unfinished task on the team that is not this one, is not in the Backlog (nothing starts work there), and does not need this one to finish first, through a wait, its sub-tasks or a dependency. `subtasks` needs at least one open sub-task, none of them in the Backlog or needing this one first. Both stay out of Needs you. The task goes back to `todo` when that work is done, and to Needs you if it was cancelled. These are checks at the moment of the wait: nothing alerts anyone if a person later moves that work to the Backlog.
- Returns the updated task row. Error: `block failed: <reason>`, with the same reasons, and the same refusal as `update_task_status` after a person moved the card.
- On a team run it blocks only the task the agent is working on (the one assigned to it). Any other task is refused with `On a team run, block_task blocks only the task you are working on. To raise a problem with another task, use add_comment on it.` Not served to an unverified HTTP caller. A wait on another task or on sub-tasks is reported as that, with no call to redo it, on team runs and task runner runs alike.
- When a run blocks its own task, on a team run or a task runner run, the task stays **Blocked** in Needs you and the steps waiting on it stay queued. If the run then ends normally, it is recorded as succeeded, the agent's reply is kept as its comment, and its delegator is told the task waits on a person. A task runner run's worktree is kept unchecked for a Retry to carry on from. A task a person assigned tells no agent: the result is on its card. On the task runner, a run that blocks its task and then runs out of turns or hits an error is recorded as failed, and one stopped by a budget or a breaker as cancelled. The task stays **Blocked** in each case.

### ask_person

Ask a person something the agent cannot decide or find out itself, about the task it is working on, then stop. Served only on a team run bound to a task, including a Clawboo Native team run whose Tasks access is read. No Tasks tool answers a question: only a person does, on the dashboard.

```ts
{
  taskId?: string // the run's own task; any other is refused
  kind: 'question' | 'confirm' | 'suggest_tasks'
  question: string // up to 2,000 characters
  options?: string[] // for 'question': up to 8 choices; none means free text
  allowOther?: boolean // for 'question': free text as well as the options
  tasks?: string[] // for 'suggest_tasks', required: up to 12 proposed titles
  idempotencyKey?: string // a repeated call with this key asks once
}
```

- Moves the task to `blocked`, waiting on the question, and closes any question it had open. When the run ends, it stays **Blocked** in Needs you as **Waiting for your answer**, the agent's reply is kept as its comment, and its delegator is told it waits on an answer and not to redo or reassign it.
- The answer starts the task again, with the answer in its comments. A suggested list the person accepts is for the agent to create.
- Refused when the agent is not on the task, the task is finished, or a person moved the card after the run started. A routine's task is refused too, because its person may be away: `This task comes from a scheduled routine, and its person may be away. Do not wait on them: make a reasonable assumption, say it in your reply, and finish.`
- A repeated `idempotencyKey` asks nothing new while that question is open or answered, and the result says which: still waiting, so stop; or answered, with the answer first, so carry on. A question that closed without an answer freed its key, so the same call asks it again and the task waits.
- After it, `block_task` and the other status tools are refused until the answer comes. `hand_back_task` still works, and closes the question.
- If the run then fails, the task still waits on the question. The run's row says it failed, but its delegator is told it waits on an answer, and the plan steps waiting on it stay queued.
- The question is the agent's text. It goes on the thread as a comment from the agent, and only the person's answer goes under their name.
- A question expires on an event, not a clock: the task reaching Done or Cancelled, being dropped or moving on, or a newer question.

### hand_back_task

Hand the task the agent is working on back to the person who asked for it, saying what they must do. Served only on a team run bound to a task, and not to a Clawboo Native team run whose Tasks access is read.

```ts
{
  taskId?: string // the run's own task; any other is refused
  need: string // what the person must do, up to 1,000 characters
}
```

- Moves the task to `blocked`, assigned to the person, and takes the agent off it. It keeps its binding to the agent, so the person's reply or **Give back to its agent** returns it. The person is the one recorded as asking for the task or its nearest ancestor, else the install's built-in person.
- Refused when the agent is not on the task, or a person moved the card after the run started. A routine's task is refused too, with the same words as `ask_person`, because its next fire needs it back in To do.

### unblock_task

Move a task to `todo` (from `blocked`, or any status that may move to `todo`). It clears the assignee and the verification verdict, like any move to `todo`.

```ts
{
  taskId: string
}
```

- Returns the updated task row. Error: `unblock failed: <reason>`, with the same reasons, and the same refusal as `update_task_status` after a person moved the card.
- Not served to an unverified HTTP caller or on a team run.

### add_comment

Add a comment to a task, such as a progress report or a note for the person.

```ts
{
  taskId: string
  body: string
  authorAgentId?: string
  authorType?: 'agent' | 'user' | 'system' // default 'agent'
}
```

- `taskId` is optional on a session bound to a task, and defaults to it.
- For an unverified HTTP caller both `authorAgentId` and `authorType` are dropped, and the comment posts as a plain `agent` comment with no author. A caller that cannot prove who it is cannot sign as someone else, or as the person.
- A session bound to an agent always posts as that agent: `authorType` is `agent` and `authorAgentId` is the session's own agent, whatever the call names. A later run's task block names each comment's author, so an agent cannot speak there as the person or as Clawboo.
- From a session bound to an agent, on someone else's task, it can wake that task's agent if the task is Blocked on what that agent said it needs, once a person has allowed that on the job. See [What wakes an agent](/concepts/the-board#what-wakes-an-agent). On a task waiting on another task or on sub-tasks it wakes no one, and from any other caller it wakes no one.
- A run going is not told. The agent reads the comment in a later run, from its task block, or from its mailbox on a task the task runner runs.
- Returns the new comment row. When it could wake someone, the row also has `wake: { state, agent, note }`: `saved`, or `declined` when a person said no on this job. `saved` does not mean a run has started, so do not wait for a reply. Error: `not found: <taskId>` for a task outside the session's team.

### link_task

Make `taskId` wait for `dependsOnTaskId`: it is not ready to claim until that task is `done`.

```ts
{
  taskId: string
  dependsOnTaskId: string
}
```

- Returns the text `linked: <taskId> depends on <dependsOnTaskId>`. Linking an edge that already exists changes nothing.
- A link to the task itself, or one that would close a loop (directly or through other tasks, including what a task is waiting on), is refused: `linking <taskId> to <dependsOnTaskId> would create a dependency cycle`. A loop could never finish, because every task in it waits on another.
- On a team-bound session both tasks must belong to the team, otherwise `not found: <id>`.

## Memory server

The Memory server saves and recalls the team's shared memory: declarative facts ("the client prefers short emails") and versioned procedures. See [Memory](/concepts/memory) for the tiers and how memory reaches an agent's prompt.

Where a call reads and writes depends on the caller:

| Caller                 | Saves go to                                               | Searches and browses see                                                                   | Feedback is recorded as                        |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Bound                  | The bound team, shared with every teammate on any runtime | Team facts, this agent's own facts, and facts that belong to no team; never another team's | The bound agent, team and task                 |
| Unverified HTTP caller | Facts that belong to no team                              | Only facts that belong to no team                                                          | No one                                         |
| Operator (stdio bin)   | The `scopeTeamId` and `scopeAgentId` arguments            | The `scopeTeamId` and `scopeAgentId` arguments                                             | The `scopeAgentId` and `scopeTeamId` arguments |

On a bound session the `scopeTeamId` and `scopeAgentId` arguments are ignored. A bound save also records provenance (the agent, runtime, task and session that saved it), which never changes who can see the fact.

### memory_save

Save a fact (`title` and `content`), or a new version of a procedure (set `procedureName`).

```ts
{
  content: string
  title?: string // required for a fact
  tags?: string[]
  procedureName?: string // save a procedure instead of a fact
  scopeTeamId?: string
  scopeAgentId?: string
}
```

- Secrets in the content are replaced with `[REDACTED]` before storage.
- Returns `{ saved: 'fact', fact }` or `{ saved: 'procedure', procedure }`. Saving a procedure under an existing name and scope stores the next version.
- Errors: `nothing to save: content was entirely redacted secrets`, and `a fact requires a title (or set procedureName for a procedure)`.

### memory_search

Search facts by keyword, by meaning, or both.

```ts
{
  query: string
  mode?: 'fts' | 'vector' | 'hybrid'
  limit?: number // integer, 1 to 100, default 10
  scopeTeamId?: string
  scopeAgentId?: string
}
```

- With no `mode`, search is `hybrid` (meaning plus keyword) when an embedding provider is available and `fts` (keyword) when not. `vector` and `hybrid` also fall back to keyword search when there is no provider or the query cannot be embedded.
- Returns an array of facts, best first. Each carries `score`, `matchedVia` (the mode that found it) and `learning`.
- `learning` is `null` for a fact nothing has used or rated yet. Otherwise its `status` is `preferred` (two or more different agent and task pairs found it useful), `tentative` (one did), `contested` (mixed reports), `dead_end` (only negative reports), or `null` (it has only been used, not rated).

### memory_browse

List the most recently updated facts the caller can see.

```ts
{ limit?: number; scopeTeamId?: string; scopeAgentId?: string } // limit: integer, 1 to 200, default 10
```

- Returns an array of facts, each with `learning` as in `memory_search`.

### memory_feedback

Report whether a recalled fact helped. Reports feed the `learning` status that search results carry.

```ts
{
  factId: string // the full id, or a unique prefix of 8 or more hex characters
  outcome: 'useful' | 'dead_end' | 'corrected'
  note?: string // required for 'corrected'
  scopeTeamId?: string
  scopeAgentId?: string
}
```

- `useful` means the fact was right and helped, `dead_end` that it misled or wasted effort, and `corrected` that it was wrong (put the correction in `note`; secrets in it are scrubbed).
- Cite the id from `memory_search`, or the id prefix shown in the memory block of the agent's prompt.
- A fact the caller cannot see gets the same error as a missing one, so feedback cannot reveal another team's facts. That error begins `unknown fact id (or ambiguous prefix)`. The other error is `corrected requires a note with the correction`.
- Returns `{ recorded, learning }`.
- Each reporter (an agent and task pair) counts once per direction, at the weight of its newest report, so repeating a report adds nothing. An unverified caller is recorded as no one, so it cannot promote a fact on its own.

## Tools server

The Tools server is Clawboo's tool broker. Every call is checked, may wait for a person's approval, then runs and is recorded in the tool audit. Approval requests appear under **Needs you** on the Board and in the Governance approval queue (see [Approvals](/using/approvals)).

`tools/list` contains:

- The [builtin tools](#builtin-tools) whose requirements are met.
- The tools of every live [connector](/using/connectors) that the calling agent's grants allow. A connector tool the agent has not been granted is not listed at all. The list is recomputed for every list and every call, and the server sends a list-changed notification when a connector connects or disconnects.
- [`read_tool_result`](#read_tool_result), always. Grants, availability and connector tools never hide or replace it.

A call goes through these checks in order:

1. The tool must exist, be enabled and be available, and its arguments must validate.
2. A connector tool must pass the grant check for the calling agent and team.
3. A call whose arguments point at the Clawboo dashboard is refused with `dashboard:agents may not open the Clawboo dashboard`. That is any loopback address on the port the server listens on (`localhost` or a name under `.localhost`, any `127.x.x.x` address, `::1`, `::` and `0.0.0.0`, and their IPv4-mapped IPv6 forms), and the address set in `HOST` on that port. Hosts are read the way a browser reads them, so numeric (`2130706433`), percent-escaped and full-width spellings, a leading zero on the port, and a tab or line break inside the address are refused too. A name that reaches the server through a reverse proxy or `CLAWBOO_ALLOWED_HOSTS` is not refused. A call whose `url` argument would open a file on this computer is refused with `local-file:agents may not open files on this computer`: a `file:` or `view-source:` address, read as a browser reads it, or a Windows drive or network path such as `C:\Users` or `\\server\share`, which Chrome on Windows opens as a file. A security scan of the arguments can refuse the call. Numeric `limit`, `max`, `count`, `maxResults`, `top_k` and `topK` arguments above 1,000 are lowered to 1,000.
4. A destructive tool, an external tool that is not read-only, or a grant that asks for approval waits up to 5 minutes for a person to answer. An earlier **Always** for the same tool under the same grant skips this wait, but never for a destructive tool, a grant set to `always`, or a run that might leak data.
5. The call runs, and its arguments and result are recorded in the audit with secrets scrubbed.

Results:

- A refused call returns the tool error `denied: <reason>`, and the same reason in `_meta.denied`. Reasons start with `unknown-tool:`, `disabled:`, `unavailable:`, `provenance:`, `invalid-args:`, `grant:` (for example `grant:no-grant`; see the [grant decision reasons](/reference/events-and-errors#grant_decision)), `dashboard:`, `local-file:`, `security:` or `scope:`.
- A call whose approval is refused, expires or times out returns `approval deny`, `approval expired` or `approval timeout`.
- A text result larger than 16 KiB is stored whole (up to 8 MiB) and the model gets a trimmed view: the start and the end of the result, with a notice between them that carries a `tr_` handle and the exact `read_tool_result` call for the rest. Only the Tools server trims results; the other three servers bound theirs with `limit` arguments. Stored results are deleted after 7 days (`CLAWBOO_TOOL_RESULT_TTL_MS`).

### Builtin tools

These two exist to exercise the broker (the round trip and the audit). Neither has a side effect.

| Tool   | Arguments                      | Risk | Listed | Returns                            |
| ------ | ------------------------------ | ---- | ------ | ---------------------------------- |
| `echo` | `{ message: string }`          | safe | Always | The message                        |
| `note` | `{ note: string }` (non-empty) | safe | Always | `noted: <note>`; nothing is stored |

There is no built-in web search. For search, connect a search connector such as Exa Search in [Connectors](/using/connectors) and give it to the agents that need it; its tools are then listed as [connector tools](#connector-tools). With no grant that covers every agent (a `global` grant), an unverified caller is served three tools: `echo`, `note` and `read_tool_result`.

### Connector tools

- A connector tool is named `mcp__<connector-slug>__<tool-name>`, at most 128 characters. Its description is the connector's own, unchanged.
- A brokered connector (one service that fronts many apps, such as Composio) gets one line appended to its app-facing tools' descriptions: `Apps this agent may use: ...` for a bound agent, or `Apps reachable here, each subject to the operator approving the first call: ...` for an unverified caller.
- The agent's grants decide which connector tools it is offered and whether a call is allowed, asks for approval, or is denied. See [Connectors](/using/connectors).

### read_tool_result

Read back a result that was too large to return whole.

```ts
{
  handle: string // the tr_ handle from the trimmed result
  offset?: number // integer, at least 0, in bytes
  limit?: number // integer, at least 1, in bytes; capped at 16 KiB
  search?: string
}
```

- Returns the requested bytes, then a line with the total size and the exact call for the next page, or `This is the end of the result.` When the stored copy itself was cut at 8 MiB, that line says how many bytes were kept.
- With `search`, returns only the lines that contain the text (case-insensitive), each prefixed with its byte offset as `[byte <n>]` so the next call can seek to it.
- An unknown or expired handle is an error that begins `No stored result for handle` and tells the model to re-run the original call with narrower arguments.
- Its own result is never trimmed. Handles are random and work from any session, so a handle is as sensitive as the result it points to.

## TeamChat server

The TeamChat server is the agents' peer room. Teammates on any runtime post as named peers and read each other's posts. This room is separate from the team chat you see in the dashboard (General and its rooms); see [Peer chat](/concepts/peer-chat). A post never changes the board.

- On a bound session the author and room come from the binding, and any `authorAgentId`, `teamId` or `roomId` argument is ignored, so a runtime cannot post as a teammate it is not. The room is `team:<teamId>`.
- On the stdio bin, pass `authorAgentId` and `teamId`; `roomId` defaults to `team:<teamId>`.
- An unverified HTTP caller is served no tools, because both tools need an author and a room.
- On a bound session, `team_chat_post` and `team_delegate` results can carry mailbox notices like the Tasks tools. `team_chat_subscribe` results never do.

### team_chat_post

Post a message to the peer room.

```ts
{ text: string; authorAgentId?: string; teamId?: string; roomId?: string }
```

- Returns `{ posted: { seq, roomId, authorAgentId } }`. `seq` goes up by one with each post in the room.
- Errors: `a post requires non-empty text`, and on the stdio bin `no bound identity: pass authorAgentId + teamId (unbound mode)`.
- A bound post over HTTP also writes a `team_chat_post` event to the [event log](/reference/events-and-errors).

### team_chat_subscribe

Read new posts since a cursor. The caller's own posts are never returned.

```ts
{
  sinceSeq?: number // integer, at least 0, default 0
  limit?: number // integer, 1 to 500; up to 1,000 posts when omitted
  authorAgentId?: string
  teamId?: string
  roomId?: string
}
```

- Returns `{ posts, nextSeq }`, oldest post first. Each post is `{ seq, authorAgentId, kind, wrapped }`.
- `wrapped` presents the post as evidence, not as an instruction. It is a header line, `[Inter-session message · from=<agent> · kind=<kind> · seq=<n> · isUser=false]`, then the body with every line prefixed `| `. Text in the body that imitates such a header becomes `[peer-quoted header]`, and one that never closes loses its opening words the same way. A teammate's post is context to weigh, never an order from the person.
- `nextSeq` is the room's newest `seq`, never lower than `sinceSeq`. When the page is full (`limit` posts, or 1,000 with no `limit`), it is the `seq` of the last post returned instead, so the next read picks up the rest.
- Error (stdio bin only): `no bound identity: pass authorAgentId + teamId (unbound mode)`.

### team_delegate

Hand a self-contained piece of work to a teammate by name. It is served only on runs the team engine drives (a signed `delegate=1`), and it is how Claude Code, Codex and Hermes team leaders delegate. Clawboo Native leaders use their own built-in `delegate` tool instead.

```ts
{
  assignee: string
  task: string
} // assignee is the teammate's name, for example "Coder"
```

- The tool writes nothing itself. The team engine sees the call and creates the board task for that teammate, who reports back when done. See [Delegation and orchestration](/concepts/delegation-and-orchestration).
- Returns `Queued for <assignee>: <task>. If <assignee> is a teammate here, they get it as a board task and report back to you when done. If it cannot start, you will get a message saying why.` whenever both fields are present. The answer comes before the engine matches the name.
- A name that matches no teammate in the room, or the caller itself, creates no task. The engine then sends the caller a `[Task Update]` saying the hand-off did not start, with the names of the teammates it can hand work to.
- Error: `team_delegate requires both an assignee (teammate name) and a task`.

## Transports

Every server is built from the same code and served three ways.

### stdio bins

The `clawboo` npm package installs one command per server. The client that spawns a bin owns its process.

| Command                | Server   |
| ---------------------- | -------- |
| `clawboo-mcp-tasks`    | Tasks    |
| `clawboo-mcp-memory`   | Memory   |
| `clawboo-mcp-tools`    | Tools    |
| `clawboo-mcp-teamchat` | TeamChat |

- The bins open `CLAWBOO_DB_PATH`, or `~/.openclaw/clawboo/clawboo.db` when it is unset. That is a different file from the dashboard's database (`~/.clawboo/clawboo.db`), on purpose. To work on the dashboard's board and memory, set `CLAWBOO_DB_PATH` to the dashboard's file; the stdio snippets from `GET /api/mcp/config` already do.
- The Memory bin picks an embedding provider and checks again once a minute: a local Ollama with `nomic-embed-text` at `http://localhost:11434` first, then `OPENAI_API_KEY` from its environment, unless the store holds local vectors and you have not allowed remote embeddings. With neither, search is keyword-only. `CLAWBOO_DISABLE_EMBEDDINGS=1` turns embeddings off.
- The Tools bin serves the builtins and `read_tool_result`; it has no connector tools.
- The TeamChat bin is unbound, so author and team come from the tool arguments.

### Streamable HTTP

The dashboard server mounts each server at `/api/mcp/<server>`, where `<server>` is `tasks`, `memory`, `tools` or `teamchat`.

| Method   | Path                | Use                                                         |
| -------- | ------------------- | ----------------------------------------------------------- |
| `POST`   | `/api/mcp/<server>` | JSON-RPC requests: `initialize`, `tools/list`, `tools/call` |
| `GET`    | `/api/mcp/<server>` | The event stream of an open session                         |
| `DELETE` | `/api/mcp/<server>` | Close a session                                             |

- A session starts with `initialize`. Its response carries an `mcp-session-id` header that every later request must send. Sessions live in the server's memory, so after a restart a client must initialize again.
- A `POST` must send `Accept: application/json, text/event-stream`, or it gets HTTP 406; a `GET` needs `Accept: text/event-stream`. A body that is not JSON gets HTTP 415.
- `No valid session; send an initialize request first.` (HTTP 400) answers a `POST` that is not `initialize` and has no known session. `Invalid or missing MCP session id.` (HTTP 400) answers a `GET` or `DELETE` without one. Both are JSON-RPC errors with code `-32000` and `id: null`. A server failure before the response starts returns HTTP 500 with `{ "error": "..." }`.
- The MCP routes share the general API rate limit; see [Limits and defaults](/reference/limits-and-defaults).

When the access gate is on (`STUDIO_ACCESS_TOKEN` is set), every `/api/` request needs the access cookie. A cookieless request to one of the four MCP paths is let through only when it carries a valid `attachToken`, arrives on a loopback connection, and has none of the `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `X-Real-IP` headers. A request through a reverse proxy therefore always needs the cookie. `GET /api/mcp/config` always needs the cookie when the gate is on, because it signs identities. See [Security](/operating/security).

### In-process

Clawboo Native agents use the same servers inside the dashboard server, through an in-memory MCP client. There is no URL and no token, and the run's team and agent are bound directly.

### Attach snippets

`GET /api/mcp/config` returns a ready-to-paste attach snippet. Copy URLs from it rather than building them, because only it can sign them.

| Parameter                     | Values                                          | Default       |
| ----------------------------- | ----------------------------------------------- | ------------- |
| `server`                      | `tasks`, `memory`, `tools`, `teamchat`          | `tasks`       |
| `runtime`                     | `claude-code`, `codex`, `openclaw`              | `claude-code` |
| `transport`                   | `http`, `stdio` (any other value means `stdio`) | `http`        |
| `scopeTeamId`, `scopeAgentId` | Ids to bind the session to                      | Unscoped      |

- Returns `{ ok: true, config: { id, transport, snippet, structured } }`. An unknown `server` is HTTP 400 `unknown server: <name>`. An unknown `runtime` returns `{ ok: true }` with no `config`.
- HTTP URLs use the server's own loopback address and port, never the request's `Host` header. They always carry `attachToken`, and a `scopeSig` when scoped.
- A Claude Code HTTP snippet looks like `claude mcp add --transport http clawboo-tasks 'http://127.0.0.1:<port>/api/mcp/tasks?attachToken=<hex>'`. The URL is single-quoted because it carries a query string.

The full route reference is in the [Tools and MCP API](/reference/rest-api/tools-and-mcp).

## Errors on every server

| Error text                | Meaning                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `unknown tool: <name>`    | The tool is not on this session's list, for example a hidden or ungranted tool |
| `invalid args: <details>` | The arguments failed the tool's schema; `<details>` lists the problems         |

Both are tool results with `isError: true`. Errors specific to a tool are listed under that tool.

## Related

- [Attaching Clawboo's MCP servers](/operating/mcp-servers): attach an agent of your own, step by step.
- [Tools and MCP API](/reference/rest-api/tools-and-mcp): approvals, audit and the attach-config route.
- [The board](/concepts/the-board): statuses, legal moves and claiming.
- [Memory](/concepts/memory): memory tiers, recall and learning.
- [Connectors](/using/connectors): connect services and grant them to agents.
- [Events and errors](/reference/events-and-errors): the events these tools write.
