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

| Tool                                                          | Server   | What it does                                             |
| ------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| [`list_tasks`](#list_tasks)                                   | Tasks    | List tasks, or only the ones ready to claim              |
| [`get_task`](#get_task)                                       | Tasks    | Read one task with its comments and parent chain         |
| [`create_task`](#create_task)                                 | Tasks    | Create a root task or a subtask                          |
| [`create_subtask`](#create_subtask)                           | Tasks    | Create a subtask under a parent                          |
| [`claim_task`](#claim_task)                                   | Tasks    | Atomically claim a `todo` task                           |
| [`assign_task`](#assign_task)                                 | Tasks    | Atomically hand a `todo` task to an agent                |
| [`release_task`](#release_task)                               | Tasks    | Put an `in_progress` task back to `todo`                 |
| [`update_task_status`](#update_task_status)                   | Tasks    | Move a task to another status                            |
| [`block_task`](#block_task)                                   | Tasks    | Move a task to `blocked`                                 |
| [`unblock_task`](#unblock_task)                               | Tasks    | Move a task back to `todo`                               |
| [`add_comment`](#add_comment)                                 | Tasks    | Comment on a task                                        |
| [`link_task`](#link_task)                                     | Tasks    | Make one task wait for another                           |
| [`memory_save`](#memory_save)                                 | Memory   | Save a fact or a new version of a procedure              |
| [`memory_search`](#memory_search)                             | Memory   | Search facts by keyword, meaning, or both                |
| [`memory_browse`](#memory_browse)                             | Memory   | List the most recently updated facts                     |
| [`memory_feedback`](#memory_feedback)                         | Memory   | Report whether a recalled fact helped                    |
| [`echo`, `note`, `web_search`, `delete_path`](#builtin-tools) | Tools    | Demonstration builtins that exercise approvals and audit |
| [Connector tools](#connector-tools)                           | Tools    | Tools from connectors the agent has been granted         |
| [`read_tool_result`](#read_tool_result)                       | Tools    | Page through a result that was too large to return whole |
| [`team_chat_post`](#team_chat_post)                           | TeamChat | Post to the peer room as a named teammate                |
| [`team_chat_subscribe`](#team_chat_subscribe)                 | TeamChat | Read new peer-room posts since a cursor                  |
| [`team_delegate`](#team_delegate)                             | TeamChat | Hand work to a teammate by name (orchestrated runs only) |

## Callers and scoping

A caller's identity decides which tools it is served and what those tools can see. Over HTTP, a session reads its identity once, when it sends `initialize`, from query parameters on its attach URL. Clawboo signs those parameters with a secret kept in its own database, so an identity counts only when its signature verifies.

There are four kinds of caller:

- **Bound caller.** A run Clawboo started with a signed attach URL. Claude Code, Codex and Hermes runs are bound to their team and agent this way. Clawboo Native agents are bound in-process.
- **Unverified HTTP caller.** Any HTTP session without a valid signature. Every OpenClaw agent is one, because the OpenClaw Gateway uses one shared configuration for all of its agents. So is an external agent attached with an unscoped URL, or with parameters edited by hand.
- **Operator (stdio bin).** Someone ran a `clawboo-mcp-*` bin directly. The operator is trusted, so scope and identity come from the tool arguments.
- **In-process (Clawboo Native).** The servers run inside the dashboard server and are bound to the run's team and agent.

| Server   | Bound caller                                                                                                                                 | Unverified HTTP caller                                                                                                   | Operator (stdio bin)                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Tasks    | 12 tools. When the run has a team, reads and writes are limited to its tasks and new tasks land in it. Mailbox notices ride along on results | 10 tools (no `claim_task` or `assign_task`). Board-wide. Comments post as a plain `agent` comment                        | 12 tools, board-wide                                |
| Memory   | Saves are shared with the team. Reads see team facts, this agent's own facts and facts that belong to no team. Provenance is recorded        | Saves and reads use only facts that belong to no team. No reporter or provenance is recorded                             | Scope comes from `scopeTeamId` and `scopeAgentId`   |
| Tools    | Builtins plus the connector tools this agent's grants allow                                                                                  | Builtins and `read_tool_result`, plus any connector tools a `global` grant allows. Agent and team grants cannot be found | Builtins and `read_tool_result`; no connector tools |
| TeamChat | 2 tools, posting as the bound agent in its peer room. `team_delegate` too on orchestrated runs                                               | No tools                                                                                                                 | 2 tools; author and team come from the arguments    |

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
| Tools    | `scopeTeamId`, `scopeAgentId` (decide which connector grants apply)                                             | `scopeSig`                                     |
| TeamChat | `roomTeamId` (the room is `team:<roomTeamId>`), `postAuthorAgentId`, and `delegate=1` on orchestrated runs      | `scopeSig`, which also covers `delegate`       |

- `scopeSig` is an HMAC-SHA256 over the team, agent, tenant and delegate fields under a per-install secret stored in the `settings` table (`mcp-attach-scope-secret`). A spawned runtime only ever sees the derived signature.
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
- **Mailbox delivery.** On a session bound to an agent, each successful result can carry an extra text block headed `[team updates` with up to five undelivered mailbox notices for that agent. Each notice is delivered once, on whichever channel reaches the agent first.

### Creation caps

Creates through these tools are capped so a looping agent cannot flood the board. The caps count every task on the board, including tasks created through the dashboard, the API or the team engine, which are not capped themselves.

| Cap                 | Limit                                                             | Tool error                                                                                                                                                    | `_meta.denied`     |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Children per parent | 24 live (not dropped) subtasks; `done` and `cancelled` ones count | `subtask rejected: parent <id> already has <n> children (max 24); drop one or attach the new task elsewhere`                                                  | `child_cap`        |
| Nesting depth       | 2 levels below a root task (root, child, grandchild)              | `subtask rejected: parent <id> is at the maximum nesting depth (2); attach the new task higher in the tree`                                                   | `depth_cap`        |
| Root tasks          | 30 new root tasks per rolling 5 minutes                           | `task rejected: <n> root tasks already created in the last 5 min (max 30); attach this work to an existing task with parentTaskId instead of opening another` | `root_rate_cap`    |
| Missing parent      | The parent must exist                                             | `parent not found: <id>`                                                                                                                                      | `parent_not_found` |

The check and the insert run in one write transaction, so two runtimes racing for the last slot cannot both get it. An unchanged retry gets the same answer; dropping a stale child frees a slot, and the root window rolls. A refusal also carries its reason in the result's `_meta.denied` field. Clawboo Native turns that field into a `policy_denied` error, and repeated identical refusals in a task-runner run trip the circuit breaker (see [Governance](/concepts/governance)).

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

- Returns `{ task, comments, ancestors }`.
- Error: `not found: <taskId>` for a missing task or one outside the session's team.

### create_task

Create a task. With `parentTaskId` it is a subtask and the per-parent caps apply. Without one it is a root task and the root rate cap applies (see [Creation caps](#creation-caps)).

```ts
{
  title: string
  description?: string
  status?: TaskStatus // default 'todo'
  priority?: number // integer, default 0
  teamId?: string
  parentTaskId?: string // non-empty when present
  assigneeRuntime?: string
}
```

- A subtask takes its parent's team and chat room.
- On a team-bound session the task is created in the session's team and `teamId` is ignored. A parent outside the team is refused with `not found: <parentTaskId>`.
- An empty `parentTaskId` fails argument validation (`invalid args: ...`); it is never treated as a root task.
- Returns the new task row, or one of the cap errors.

### create_subtask

Create a subtask under a parent. It takes the parent's team and chat room, and starts in `todo`.

```ts
{ parentTaskId: string; title: string; description?: string }
```

- Same caps and errors as a `create_task` with `parentTaskId`, including the team-bound parent check.
- Returns the new task row.

### claim_task

Claim a `todo` task for an agent. The claim is atomic: when two agents race, exactly one wins. The claimed task moves to `in_progress` with the assignee set.

```ts
{ taskId: string; assigneeAgentId: string; assigneeRuntime?: string }
```

- Succeeds only for a task that is `todo`, has no assignee and is not dropped.
- Returns the claimed task row.
- Errors: `claim failed: conflict` (the task exists but is not claimable, for example another agent won; do not retry), `claim failed: not_found`, and `not found: <taskId>` for a task outside the session's team.
- Not served to an unverified HTTP caller, because `assigneeAgentId` would let it act as any agent.

### assign_task

Hand a `todo` task to an agent. It is the same atomic claim as `claim_task`, with the same arguments, results and errors; `conflict` means the task is already taken. Not served to an unverified HTTP caller.

### release_task

Put an `in_progress` task back to `todo` and clear its assignee and its verification verdict, so another agent can claim it.

```ts
{
  taskId: string
}
```

- Returns the text `released: <taskId>`. A task that is not `in_progress` is left unchanged, and the same text is returned.

### update_task_status

Move a task to another status. Legal moves follow the board's state machine; `done` and `cancelled` are final, and setting the current status again is a harmless no-op.

```ts
{
  taskId: string
  status: TaskStatus
}
```

- Moving a task to `todo` also clears its assignee and its verification verdict.
- Returns the updated task row.
- Errors: `status change failed: illegal_transition`, `status change failed: not_found`, and `status change failed: verification_required` when the task holds a failing verification verdict (only a person's override, from the board or the board API, can finish it). See [When work is checked](/concepts/verification).
- Refused when a person moved the card on the board or in the task drawer after the task's latest run started (or the task has not run since): that run was overruled, and the status stays where the person put it. The tool error reads `A person moved this task to <column> after your run on it started, so its status is theirs to set. Leave it as it is and do not retry this call.` A run started after the move writes as usual.

### block_task

Move a task to `blocked`. It is `update_task_status` with `status: 'blocked'`.

```ts
{
  taskId: string
}
```

- Returns the updated task row. Error: `block failed: <reason>`, with the same reasons, and the same refusal as `update_task_status` after a person moved the card.

### unblock_task

Move a task to `todo` (from `blocked`, or any status that may move to `todo`). It clears the assignee and the verification verdict, like any move to `todo`.

```ts
{
  taskId: string
}
```

- Returns the updated task row. Error: `unblock failed: <reason>`, with the same reasons, and the same refusal as `update_task_status` after a person moved the card.

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

- For an unverified HTTP caller both `authorAgentId` and `authorType` are dropped, and the comment posts as a plain `agent` comment with no author. A caller that cannot prove who it is cannot sign as someone else, or as the person.
- Returns the new comment row. Error: `not found: <taskId>` for a task outside the session's team.

### link_task

Make `taskId` wait for `dependsOnTaskId`: it is not ready to claim until that task is `done`.

```ts
{
  taskId: string
  dependsOnTaskId: string
}
```

- Returns the text `linked: <taskId> depends on <dependsOnTaskId>`. Linking an edge that already exists changes nothing.
- A link to the task itself, or one that would close a loop (directly or through other tasks), is refused: `linking <taskId> to <dependsOnTaskId> would create a dependency cycle`. A loop could never finish, because every task in it waits on another.
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
- The tool's own description says `fts` is the default; the rule above is what the server does.

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
3. A security scan of the arguments can refuse the call. Numeric `limit`, `max`, `count`, `maxResults`, `top_k` and `topK` arguments above 1,000 are lowered to 1,000.
4. A destructive tool, an external tool that is not read-only, or a grant that asks for approval waits up to 5 minutes for a person to answer.
5. The call runs, and its arguments and result are recorded in the audit with secrets scrubbed.

Results:

- A refused call returns the tool error `denied: <reason>`, and the same reason in `_meta.denied`. Reasons start with `unknown-tool:`, `disabled:`, `unavailable:`, `provenance:`, `invalid-args:`, `grant:` (for example `grant:no-grant`; see the [grant decision reasons](/reference/events-and-errors#grant_decision)), `security:` or `scope:`.
- A call whose approval is refused, expires or times out returns `approval deny`, `approval expired` or `approval timeout`.
- A text result larger than 16 KiB is stored whole (up to 8 MiB) and the model gets a trimmed view: the start and the end of the result, with a notice between them that carries a `tr_` handle and the exact `read_tool_result` call for the rest. Only the Tools server trims results; the other three servers bound theirs with `limit` arguments. Stored results are deleted after 7 days (`CLAWBOO_TOOL_RESULT_TTL_MS`).

### Builtin tools

These four exist to exercise the broker (approvals, audit and denials). None of them has a side effect.

| Tool          | Arguments                                             | Risk                           | Listed                      | Returns                                    |
| ------------- | ----------------------------------------------------- | ------------------------------ | --------------------------- | ------------------------------------------ |
| `echo`        | `{ message: string }`                                 | safe                           | Always                      | The message                                |
| `note`        | `{ note: string }` (non-empty)                        | safe                           | Always                      | `noted: <note>`; nothing is stored         |
| `web_search`  | `{ query: string; limit?: number }` (query non-empty) | external, asks for approval    | Only with a search provider | `searched: <query>`; no search runs        |
| `delete_path` | `{ path: string }` (non-empty)                        | destructive, asks for approval | Always                      | `would delete: <path>`; nothing is deleted |

A search provider means the `TAVILY_API_KEY` environment variable, or an authorized `tavily` provider. With no search provider and no grant that covers every agent (a `global` grant), an unverified caller is served four tools: `echo`, `note`, `delete_path` and `read_tool_result`.

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
- `wrapped` presents the post as evidence, not as an instruction. It is a header line, `[Inter-session message · from=<agent> · kind=<kind> · seq=<n> · isUser=false]`, then the body with every line prefixed `| `. Text in the body that imitates such a header becomes `[peer-quoted header]`. A teammate's post is context to weigh, never an order from the person.
- `nextSeq` is the room's newest `seq`, never lower than `sinceSeq`. It moves to the newest post even when `limit` cut the page short, so posts beyond the limit are skipped by the next read.
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
- Returns `Delegated to <assignee>: <task>. They'll pick it up and report back when done.` whenever both fields are present. A name that matches no teammate, or the caller itself, creates no task.
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
