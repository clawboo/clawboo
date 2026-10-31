---
title: 'Database schema reference'
sidebarTitle: 'Database schema'
description: 'Every table, column and index in the SQLite database that holds Clawboo state, and how the schema is created and upgraded.'
keywords:
  [
    'sqlite',
    'clawboo.db',
    'tables',
    'columns',
    'indexes',
    'migrations',
    'ensureSchema',
    'reconcileSchema',
  ]
---

This page is for developers and operators who query or back up Clawboo's database directly. Clawboo keeps its durable state in one SQLite file, `clawboo.db`: 35 tables, plus a full-text search table for memory. Every column and index below comes from the schema definition in `packages/db/src/schemaBootstrap.ts`.

To copy the database while Clawboo runs, use `clawboo backup` (see the [CLI reference](/reference/cli)). Where the file lives and how to reset it are in [Data and state](/operating/data-and-state).

## Tables at a glance

| Table                                           | Group                    | Holds                                            |
| ----------------------------------------------- | ------------------------ | ------------------------------------------------ |
| [`teams`](#teams)                               | Teams and agents         | Teams                                            |
| [`agents`](#agents)                             | Teams and agents         | The agent registry, for every runtime            |
| [`sessions`](#sessions)                         | Teams and agents         | Clawboo Native sessions and rotated run sessions |
| [`boo_zero_team_briefs`](#boo_zero_team_briefs) | Teams and agents         | Boo Zero's brief for each team                   |
| [`team_profiles`](#team_profiles)               | Teams and agents         | Stored team templates (unused by the server)     |
| [`chat_messages`](#chat_messages)               | Chat                     | Chat transcripts                                 |
| [`rooms`](#rooms)                               | Chat                     | A team's chat rooms                              |
| [`room_members`](#room_members)                 | Chat                     | Room membership                                  |
| [`tasks`](#tasks)                               | Board                    | Task cards                                       |
| [`task_deps`](#task_deps)                       | Board                    | Which task waits for which                       |
| [`task_comments`](#task_comments)               | Board                    | Comments and notes on tasks                      |
| [`workspaces`](#workspaces)                     | Board                    | The git worktree a task ran in                   |
| [`execution_processes`](#execution_processes)   | Board                    | One row per run, with cost and status            |
| [`scheduled_runs`](#scheduled_runs)             | Routines                 | Routines                                         |
| [`memory_facts`](#memory_facts)                 | Memory                   | Facts                                            |
| [`memory_procedures`](#memory_procedures)       | Memory                   | Versioned procedures                             |
| [`memory_outcomes`](#memory_outcomes)           | Memory                   | Feedback on facts                                |
| [`tool_registry`](#tool_registry)               | Tools and approvals      | Tool metadata and on/off switches                |
| [`tool_call_audit`](#tool_call_audit)           | Tools and approvals      | Audit of every brokered tool call                |
| [`tool_call_approvals`](#tool_call_approvals)   | Tools and approvals      | Approval requests                                |
| [`tool_result_blobs`](#tool_result_blobs)       | Tools and approvals      | Oversized tool results, kept whole               |
| [`approval_history`](#approval_history)         | Tools and approvals      | A log of approval decisions                      |
| [`connectors`](#connectors)                     | Connectors and grants    | Connected connectors                             |
| [`capability_grants`](#capability_grants)       | Connectors and grants    | Who may use which connector, tool or skill       |
| [`approval_rules`](#approval_rules)             | Connectors and grants    | Remembered **Always** decisions                  |
| [`capabilities`](#capabilities)                 | Capabilities and skills  | Every runtime's skills, tools and connectors     |
| [`skills`](#skills)                             | Capabilities and skills  | Skills added to agents                           |
| [`team_chat`](#team_chat)                       | Peer room and mailbox    | Posts in the agents' own peer room               |
| [`agent_inbox`](#agent_inbox)                   | Peer room and mailbox    | Each agent's mailbox                             |
| [`cost_records`](#cost_records)                 | Spend, budgets and audit | Token and spend records                          |
| [`budgets`](#budgets)                           | Spend, budgets and audit | Spend budgets                                    |
| [`governance_audit`](#governance_audit)         | Spend, budgets and audit | Audit of governance decisions                    |
| [`orchestration_events`](#orchestration_events) | Event log                | The event log                                    |
| [`settings`](#settings)                         | Settings and layout      | Key and value settings                           |
| [`graph_layouts`](#graph_layouts)               | Settings and layout      | Saved graph positions                            |

## Conventions

- Times are `INTEGER` epoch milliseconds (columns ending in `_at`, plus `ts` and `timestamp_ms`).
- Flags are `INTEGER` `0` or `1`. JSON is stored as `TEXT`.
- `tenant_id` columns are unused and always null.
- Most ids are `TEXT`: UUIDs, or ids from an agent source. `chat_messages`, `cost_records`, `graph_layouts` and `approval_history` use an autoincrement `INTEGER` id, and `orchestration_events` is keyed by `seq`.
- Foreign keys are switched on, but only the columns below are declared as foreign keys. Every other id column (for example `tasks.team_id` or `tasks.assignee_agent_id`) is a plain reference that SQLite does not check.
- Nothing deletes rows from `orchestration_events`, `tool_call_audit` or `governance_audit`, so they grow until you reset or trim the database.

### Foreign keys

| Column                                              | References      | When the referenced row is deleted |
| --------------------------------------------------- | --------------- | ---------------------------------- |
| `agents.team_id`                                    | `teams.id`      | Refused while rows point at it     |
| `cost_records.agent_id`                             | `agents.id`     | Refused while rows point at it     |
| `approval_history.agent_id`                         | `agents.id`     | Refused while rows point at it     |
| `boo_zero_team_briefs.team_id`                      | `teams.id`      | The brief is deleted with it       |
| `rooms.team_id`                                     | `teams.id`      | The rooms are deleted with it      |
| `room_members.room_id`                              | `rooms.id`      | Memberships are deleted with it    |
| `room_members.agent_id`                             | `agents.id`     | Memberships are deleted with it    |
| `tasks.parent_task_id`                              | `tasks.id`      | Refused while rows point at it     |
| `task_deps.task_id`, `task_deps.depends_on_task_id` | `tasks.id`      | Refused while rows point at it     |
| `task_comments.task_id`                             | `tasks.id`      | Refused while rows point at it     |
| `workspaces.task_id`                                | `tasks.id`      | Refused while rows point at it     |
| `execution_processes.task_id`                       | `tasks.id`      | Refused while rows point at it     |
| `execution_processes.workspace_id`                  | `workspaces.id` | Refused while rows point at it     |

In the column tables below, `FK` marks these columns and `cascade` marks the ones deleted with their parent.

## Teams and agents

### teams

One row per team.

| Column                | Type                             | Notes                                             |
| --------------------- | -------------------------------- | ------------------------------------------------- |
| `id`                  | `TEXT`, PK                       |                                                   |
| `name`                | `TEXT`, not null                 | Display name                                      |
| `icon`                | `TEXT`, not null                 | An emoji                                          |
| `color`               | `TEXT`, not null                 | Hex color                                         |
| `color_collection_id` | `TEXT`                           | The Boo color collection the team's avatars use   |
| `template_id`         | `TEXT`                           | The marketplace team it was deployed from, if any |
| `leader_agent_id`     | `TEXT`                           | The team's Leader, when one is set                |
| `is_archived`         | `INTEGER`, not null, default `0` | `1` once the team is archived                     |
| `tenant_id`           | `TEXT`                           | Unused                                            |
| `created_at`          | `INTEGER`, not null              |                                                   |
| `updated_at`          | `INTEGER`, not null              |                                                   |

Indexes: `idx_teams_name` (`name`).

### agents

The agent registry. Every agent source (OpenClaw, Clawboo Native, Claude Code, Codex and Hermes) records its agents here, so the fleet still renders when the OpenClaw Gateway is offline. For OpenClaw agents, `name`, `status`, `identity_json` and `source_agent_id` are overwritten on every sync; the other columns are Clawboo's own.

| Column               | Type                                   | Notes                                                                                                                                             |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `TEXT`, PK                             |                                                                                                                                                   |
| `name`               | `TEXT`, not null                       | Display name                                                                                                                                      |
| `gateway_id`         | `TEXT`, not null                       | The agent's id in its source; for OpenClaw, the Gateway's agent id                                                                                |
| `avatar_seed`        | `TEXT`                                 | Seed for the agent's Boo avatar                                                                                                                   |
| `personality_config` | `TEXT`                                 | JSON `{ values, customText }`: personality sliders and custom text                                                                                |
| `exec_config`        | `TEXT`                                 | JSON run settings, such as an OpenClaw agent's exec policy or a coding-runtime agent's model                                                      |
| `team_id`            | `TEXT`, FK `teams.id`                  | Null when the agent belongs to no team                                                                                                            |
| `status`             | `TEXT`, not null, default `'idle'`     | Synced status                                                                                                                                     |
| `source_id`          | `TEXT`, not null, default `'openclaw'` | The agent source that owns the row: `openclaw`, `clawboo-native`, `claude-code`, `codex` or `hermes`                                              |
| `source_agent_id`    | `TEXT`                                 | The upstream id; equal to `gateway_id`                                                                                                            |
| `identity_json`      | `TEXT`                                 | JSON identity from the Gateway (name, emoji, avatar, theme)                                                                                       |
| `participant_kind`   | `TEXT`, not null, default `'agent'`    | `agent` or `human`; a routine cannot target a `human`                                                                                             |
| `runtime`            | `TEXT`, not null, default `'openclaw'` | The runtime the agent runs on: `openclaw`, `clawboo-native`, `claude-code`, `codex` or `hermes` (`clawboo-mock` when the mock runtime is enabled) |
| `capabilities`       | `TEXT`                                 | JSON capability hints; unused                                                                                                                     |
| `tenant_id`          | `TEXT`                                 | Unused                                                                                                                                            |
| `archived_at`        | `INTEGER`                              | Set when the agent is archived (a soft delete); null while it is live                                                                             |
| `created_at`         | `INTEGER`, not null                    |                                                                                                                                                   |
| `updated_at`         | `INTEGER`, not null                    |                                                                                                                                                   |

Indexes: `idx_agents_gateway_id` (`gateway_id`), `idx_agents_status` (`status`), `idx_agents_team_id` (`team_id`), `idx_agents_source` (`source_id`, `source_agent_id`).

### sessions

Clawboo Native's sessions, and the chain of sessions a task-runner run moves through when it rotates. OpenClaw sessions live in the Gateway and are not stored here.

| Column              | Type                                   | Notes                                                                   |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `id`                | `TEXT`, PK                             |                                                                         |
| `source_id`         | `TEXT`, not null, default `'openclaw'` | Who owns the session: `clawboo-native`, or the runtime of a rotated run |
| `source_session_id` | `TEXT`, not null                       | The session's id in its source                                          |
| `agent_id`          | `TEXT`                                 | Plain reference to `agents.id`                                          |
| `team_id`           | `TEXT`                                 |                                                                         |
| `status`            | `TEXT`, not null, default `'idle'`     | For example `active`, or `closed` for a rotated-away session            |
| `parent_session_id` | `TEXT`                                 | The session this one replaced after a rotation                          |
| `runtime`           | `TEXT`                                 |                                                                         |
| `tenant_id`         | `TEXT`                                 | Unused                                                                  |
| `created_at`        | `INTEGER`, not null                    |                                                                         |
| `updated_at`        | `INTEGER`, not null                    |                                                                         |

Indexes: `uniq_sessions_source` (unique: `source_id`, `source_session_id`), `idx_sessions_agent` (`agent_id`), `idx_sessions_parent` (`parent_session_id`).

### boo_zero_team_briefs

Boo Zero's brief for one team (Markdown), added to Boo Zero's context when it works on that team.

| Column       | Type                               | Notes    |
| ------------ | ---------------------------------- | -------- |
| `team_id`    | `TEXT`, PK, FK `teams.id`, cascade |          |
| `content`    | `TEXT`, not null                   | Markdown |
| `updated_at` | `INTEGER`, not null                |          |

No indexes beyond the primary key.

### team_profiles

Stored team templates. The server neither reads nor writes this table.

| Column          | Type                             | Notes                                      |
| --------------- | -------------------------------- | ------------------------------------------ |
| `id`            | `TEXT`, PK                       |                                            |
| `name`          | `TEXT`, not null                 |                                            |
| `description`   | `TEXT`                           |                                            |
| `agents_config` | `TEXT`, not null                 | JSON array of agent definitions            |
| `skills_config` | `TEXT`, not null                 | JSON array of skill references             |
| `graph_layout`  | `TEXT`                           | JSON node positions                        |
| `is_builtin`    | `INTEGER`, not null, default `0` | `1` for a template that ships with Clawboo |
| `created_at`    | `INTEGER`, not null              |                                            |

No indexes beyond the primary key.

## Chat

The team chats you use in the dashboard (General and its rooms) and one-to-one agent chats. The agents' peer room is a different table, [`team_chat`](#team_chat).

### chat_messages

Chat transcripts, so history survives a page refresh. A team chat's rows use the session key `agent:<agentId>:team:<teamId>` in General and `agent:<agentId>:team:<teamId>:room:<roomId>` in a room. **Clear chat** keeps the rows and appends `#cleared:<ts>` to `session_key` and `entry_id`, so no reader matches them again.

| Column         | Type                         | Notes                                                             |
| -------------- | ---------------------------- | ----------------------------------------------------------------- |
| `id`           | `INTEGER`, PK, autoincrement |                                                                   |
| `session_key`  | `TEXT`, not null             | The conversation the entry belongs to                             |
| `gateway_url`  | `TEXT`, not null             | The Gateway URL in use when it was saved; empty without a Gateway |
| `entry_id`     | `TEXT`, not null             | Unique per entry, so a repeated save is ignored                   |
| `timestamp_ms` | `INTEGER`, not null          | Epoch milliseconds                                                |
| `data`         | `TEXT`, not null             | JSON transcript entry                                             |

Indexes: `uniq_chat_messages_entry_id` (unique: `entry_id`), `idx_chat_messages_session_ts` (`session_key`, `timestamp_ms`), `idx_chat_messages_session_id` (`session_key`, `id`).

### rooms

A team's chat rooms: extra conversations inside its team chat, each with a subset of its members. General has no row; a room id of null means General. A room is archived, never deleted, and goes only with its team.

| Column        | Type                                     | Notes                                                         |
| ------------- | ---------------------------------------- | ------------------------------------------------------------- |
| `id`          | `TEXT`, PK                               |                                                               |
| `team_id`     | `TEXT`, not null, FK `teams.id`, cascade |                                                               |
| `name`        | `TEXT`, not null                         | The API collapses whitespace and allows at most 80 characters |
| `tenant_id`   | `TEXT`                                   | Unused                                                        |
| `archived_at` | `INTEGER`                                | Set when the room is archived; null while active              |
| `pinned_at`   | `INTEGER`                                | Set when the room is pinned to the top of the room list       |
| `created_at`  | `INTEGER`, not null                      |                                                               |
| `updated_at`  | `INTEGER`, not null                      |                                                               |

Indexes: `idx_rooms_team` (`team_id`).

### room_members

Which agents belong to which room. A room's live roster is its members that are still active agents of the room's team.

| Column       | Type                                      | Notes                                              |
| ------------ | ----------------------------------------- | -------------------------------------------------- |
| `room_id`    | `TEXT`, not null, FK `rooms.id`, cascade  |                                                    |
| `agent_id`   | `TEXT`, not null, FK `agents.id`, cascade |                                                    |
| `created_at` | `INTEGER`, not null                       | When the agent joined; the roster is ordered by it |

Primary key: `room_id`, `agent_id`. Indexes: `idx_room_members_agent` (`agent_id`).

## Board

The board is where team work is coordinated. Statuses and legal moves are described in [The board](/concepts/the-board).

### tasks

The task cards.

| Column                 | Type                                  | Notes                                                                                                                                                                                    |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `TEXT`, PK                            |                                                                                                                                                                                          |
| `title`                | `TEXT`, not null                      |                                                                                                                                                                                          |
| `description`          | `TEXT`                                |                                                                                                                                                                                          |
| `status`               | `TEXT`, not null, default `'backlog'` | `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done` or `cancelled`. Clawboo creates tasks in `todo` unless the creator picks a status, so the column default rarely applies |
| `priority`             | `INTEGER`, not null, default `0`      | Higher runs first among ready tasks                                                                                                                                                      |
| `team_id`              | `TEXT`                                | Plain reference to `teams.id`                                                                                                                                                            |
| `assignee_agent_id`    | `TEXT`                                | Plain reference to `agents.id`                                                                                                                                                           |
| `assignee_runtime`     | `TEXT`                                | The runtime that claimed it                                                                                                                                                              |
| `parent_task_id`       | `TEXT`, FK `tasks.id`                 | The parent task, for a subtask                                                                                                                                                           |
| `source_delegation_id` | `TEXT`                                | Set by the team engine: which delegation created the task and whom it reports back to                                                                                                    |
| `worktree_ref`         | `TEXT`                                | The git worktree the work happened in                                                                                                                                                    |
| `branch_ref`           | `TEXT`                                | Its git branch                                                                                                                                                                           |
| `cost_usd`             | `REAL`, not null, default `0`         | The sum of the task's recorded run costs                                                                                                                                                 |
| `parent_session_id`    | `TEXT`                                | Unused                                                                                                                                                                                   |
| `dropped`              | `INTEGER`, not null, default `0`      | `1` once soft-deleted                                                                                                                                                                    |
| `tenant_id`            | `TEXT`                                | Unused                                                                                                                                                                                   |
| `verification`         | `TEXT`                                | JSON verification verdict; null until a check runs. While it holds a failing verdict, a move to `done` is refused (`verification_required`) unless a person overrides it                 |
| `scheduled_by`         | `TEXT`, not null, default `'manual'`  | Who fires the task: `manual`, `clawboo` (the Routines engine) or `openclaw`                                                                                                              |
| `created_at`           | `INTEGER`, not null                   |                                                                                                                                                                                          |
| `updated_at`           | `INTEGER`, not null                   |                                                                                                                                                                                          |
| `completed_at`         | `INTEGER`                             | Set when the task first reaches `done` or `cancelled`                                                                                                                                    |
| `room_id`              | `TEXT`                                | Plain reference to `rooms.id`: the room the task was delegated in; null means General. A subtask takes its parent's room                                                                 |
| `person_moved_at`      | `INTEGER`                             | When a person last moved the card on the board or in the task drawer. While no run has started since, an agent's own status write through the tasks MCP tools is refused                 |

Indexes: `idx_tasks_team_status` (`team_id`, `status`), `idx_tasks_team_room` (`team_id`, `room_id`), `idx_tasks_assignee` (`assignee_agent_id`), `idx_tasks_parent` (`parent_task_id`), `idx_tasks_parent_dropped_created` (`parent_task_id`, `dropped`, `created_at`).

The `(parent_task_id, dropped, created_at)` index serves the Tasks MCP creation caps, which count live children per parent and new root tasks per 5 minutes.

### task_deps

Dependency edges: `task_id` waits for `depends_on_task_id` to be `done`.

| Column               | Type                            | Notes  |
| -------------------- | ------------------------------- | ------ |
| `task_id`            | `TEXT`, not null, FK `tasks.id` |        |
| `depends_on_task_id` | `TEXT`, not null, FK `tasks.id` |        |
| `tenant_id`          | `TEXT`                          | Unused |

Primary key: `task_id`, `depends_on_task_id`. Indexes: `idx_task_deps_task` (`task_id`), `idx_task_deps_depends` (`depends_on_task_id`).

### task_comments

Comments and system notes on a task, such as report-backs and verification results.

| Column            | Type                            | Notes                       |
| ----------------- | ------------------------------- | --------------------------- |
| `id`              | `TEXT`, PK                      |                             |
| `task_id`         | `TEXT`, not null, FK `tasks.id` |                             |
| `author_agent_id` | `TEXT`                          |                             |
| `author_type`     | `TEXT`, not null                | `agent`, `user` or `system` |
| `body`            | `TEXT`, not null                |                             |
| `tenant_id`       | `TEXT`                          | Unused                      |
| `created_at`      | `INTEGER`, not null             |                             |

Indexes: `idx_task_comments_task` (`task_id`).

### workspaces

The git worktree a task ran in.

| Column          | Type                                 | Notes                                     |
| --------------- | ------------------------------------ | ----------------------------------------- |
| `id`            | `TEXT`, PK                           |                                           |
| `task_id`       | `TEXT`, not null, FK `tasks.id`      |                                           |
| `repo_path`     | `TEXT`, not null                     | The repository the worktree was made from |
| `branch`        | `TEXT`                               |                                           |
| `worktree_path` | `TEXT`                               | The worktree folder                       |
| `status`        | `TEXT`, not null, default `'active'` | `active`, `archived` or `stale`           |
| `tenant_id`     | `TEXT`                               | Unused                                    |
| `created_at`    | `INTEGER`, not null                  |                                           |
| `last_used_at`  | `INTEGER`                            |                                           |

Indexes: `idx_workspaces_task` (`task_id`).

### execution_processes

One row per run of a task, on any runtime: its status, git checkpoints, and token and cost totals.

| Column               | Type                                 | Notes                                                                                                           |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `id`                 | `TEXT`, PK                           |                                                                                                                 |
| `task_id`            | `TEXT`, not null, FK `tasks.id`      |                                                                                                                 |
| `workspace_id`       | `TEXT`, FK `workspaces.id`           | The worktree the run used, if any                                                                               |
| `executor_type`      | `TEXT`, not null                     | The runtime id, or `openclaw` for runs the team engine fires (then `runtime` names the runtime that really ran) |
| `runtime`            | `TEXT`                               | The runtime that ran, when `executor_type` is the engine marker; otherwise null                                 |
| `status`             | `TEXT`, not null, default `'queued'` | `queued`, `running`, `succeeded`, `failed`, `timed_out` or `cancelled`                                          |
| `claimed_at`         | `INTEGER`                            |                                                                                                                 |
| `started_at`         | `INTEGER`                            |                                                                                                                 |
| `completed_at`       | `INTEGER`                            |                                                                                                                 |
| `before_commit`      | `TEXT`                               | Git commit before the run                                                                                       |
| `after_commit`       | `TEXT`                               | Git commit after the run                                                                                        |
| `input_tokens`       | `INTEGER`                            |                                                                                                                 |
| `output_tokens`      | `INTEGER`                            |                                                                                                                 |
| `cache_read`         | `INTEGER`                            |                                                                                                                 |
| `cache_write`        | `INTEGER`                            |                                                                                                                 |
| `cost_usd`           | `REAL`                               |                                                                                                                 |
| `cost_source`        | `TEXT`                               | `reported`, `local` (a model your own Ollama served), `token-estimate` or `char-estimate`; null with no cost    |
| `summary`            | `TEXT`                               | The run's result summary                                                                                        |
| `run_reason`         | `TEXT`                               | Why the run started                                                                                             |
| `error`              | `TEXT`                               | Error summary or code; see [Events and errors](/reference/events-and-errors#execution_completed)                |
| `recovery_tombstone` | `INTEGER`, not null, default `0`     | `1` once startup recovery has reaped the run, so it is never resumed twice                                      |
| `tenant_id`          | `TEXT`                               | Unused                                                                                                          |
| `created_at`         | `INTEGER`, not null                  |                                                                                                                 |

Indexes: `idx_exec_task` (`task_id`), `idx_exec_status` (`status`).

## Routines

### scheduled_runs

One row per routine. The row is the source of truth; the in-memory timer re-arms from `next_run_at` when the server starts. See [Routines](/using/routines).

| Column          | Type                                  | Notes                                                                                           |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `id`            | `TEXT`, PK                            |                                                                                                 |
| `agent_id`      | `TEXT`, not null                      | Plain reference to `agents.id`; empty for a team routine                                        |
| `team_id`       | `TEXT`                                | Plain reference to `teams.id`                                                                   |
| `cron_spec`     | `TEXT`, not null                      | A cron expression, or `once@<ISO time>` for a one-time routine                                  |
| `task_template` | `TEXT`, not null                      | JSON description of the work each fire creates                                                  |
| `status`        | `TEXT`, not null, default `'idle'`    | `idle`, `queued`, `claimed`, `running`, `paused` or `error`                                     |
| `last_run_at`   | `INTEGER`                             |                                                                                                 |
| `next_run_at`   | `INTEGER`                             | Null when nothing will fire: a spent one-time routine, a paused one, or one stopped by an error |
| `scheduled_by`  | `TEXT`, not null, default `'clawboo'` | The firing owner; the Routines engine writes `clawboo`                                          |
| `last_error`    | `TEXT`                                | The last fire's error message                                                                   |
| `tenant_id`     | `TEXT`                                | Unused                                                                                          |
| `created_at`    | `INTEGER`, not null                   |                                                                                                 |
| `updated_at`    | `INTEGER`, not null                   |                                                                                                 |

Indexes: `idx_scheduled_runs_next` (`next_run_at`), `idx_scheduled_runs_status_next` (`status`, `next_run_at`), `idx_scheduled_runs_agent` (`agent_id`).

## Memory

Shared memory: facts, versioned procedures, and the feedback that scores them. See [Memory](/concepts/memory).

### memory_facts

Declarative facts. Keyword search uses the [`memory_facts_fts`](#full-text-search) table; meaning-based search uses `embedding`. The `created_by_*` and `source_*` columns record who saved a fact and never change who can see it.

| Column                | Type                             | Notes                                                                   |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `id`                  | `TEXT`, PK                       |                                                                         |
| `title`               | `TEXT`, not null                 |                                                                         |
| `content`             | `TEXT`, not null                 |                                                                         |
| `tags`                | `TEXT`, not null, default `'[]'` | JSON array of strings                                                   |
| `embedding`           | `BLOB`                           | Float32 little-endian vector; null without an embedding provider        |
| `embedding_model`     | `TEXT`                           | The provider id that produced the vector                                |
| `scope_agent_id`      | `TEXT`                           | Set for a fact private to one agent                                     |
| `scope_team_id`       | `TEXT`                           | Set for a fact shared within one team; null means it belongs to no team |
| `tenant_id`           | `TEXT`                           | Unused                                                                  |
| `created_by_agent_id` | `TEXT`                           |                                                                         |
| `created_by_runtime`  | `TEXT`                           | `user` when saved from the dashboard                                    |
| `source_task_id`      | `TEXT`                           | The task whose run saved it                                             |
| `source_session_key`  | `TEXT`                           | The session that saved it                                               |
| `created_at`          | `INTEGER`, not null              |                                                                         |
| `updated_at`          | `INTEGER`, not null              |                                                                         |

Indexes: `idx_memory_facts_team` (`scope_team_id`), `idx_memory_facts_agent` (`scope_agent_id`), `idx_memory_facts_created` (`created_at`), `idx_memory_facts_model_created` (`embedding_model`, `created_at`, `id`).

### memory_procedures

Versioned procedures. Saving under an existing name and scope adds the next version. The provenance columns match `memory_facts`.

| Column                | Type                             | Notes  |
| --------------------- | -------------------------------- | ------ |
| `id`                  | `TEXT`, PK                       |        |
| `name`                | `TEXT`, not null                 |        |
| `version`             | `INTEGER`, not null, default `1` |        |
| `content`             | `TEXT`, not null                 |        |
| `scope_agent_id`      | `TEXT`                           |        |
| `scope_team_id`       | `TEXT`                           |        |
| `tenant_id`           | `TEXT`                           | Unused |
| `created_by_agent_id` | `TEXT`                           |        |
| `created_by_runtime`  | `TEXT`                           |        |
| `source_task_id`      | `TEXT`                           |        |
| `source_session_key`  | `TEXT`                           |        |
| `created_at`          | `INTEGER`, not null              |        |

Indexes: `idx_memory_procedures_name` (`name`), `idx_memory_procedures_team` (`scope_team_id`).

### memory_outcomes

Feedback on facts, append-only. It feeds the learning status that recall shows.

| Column       | Type                | Notes                                                                                                                            |
| ------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `TEXT`, PK          |                                                                                                                                  |
| `fact_id`    | `TEXT`, not null    | Plain reference to `memory_facts.id`                                                                                             |
| `outcome`    | `TEXT`, not null    | `useful`, `dead_end` or `corrected` from agents and the dashboard, or `cited` when a run used the fact (written only by Clawboo) |
| `note`       | `TEXT`              | The correction, for `corrected`                                                                                                  |
| `agent_id`   | `TEXT`              |                                                                                                                                  |
| `team_id`    | `TEXT`              |                                                                                                                                  |
| `task_id`    | `TEXT`              |                                                                                                                                  |
| `runtime`    | `TEXT`              |                                                                                                                                  |
| `created_at` | `INTEGER`, not null |                                                                                                                                  |

Indexes: `idx_memory_outcomes_fact` (`fact_id`), `idx_memory_outcomes_created` (`created_at`).

## Tools and approvals

The tool broker behind the [Tools MCP server](/reference/mcp-tools#tools-server): tool settings, the audit trail, approvals, and stored oversized results.

### tool_registry

Saved tool metadata and the on/off switch. A tool with no row counts as enabled.

| Column                 | Type                               | Notes                                                            |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `name`                 | `TEXT`, PK                         |                                                                  |
| `description`          | `TEXT`, not null                   |                                                                  |
| `input_schema`         | `TEXT`                             | JSON Schema                                                      |
| `availability`         | `TEXT`                             | JSON requirement, such as an environment variable                |
| `owner`                | `TEXT`, not null, default `'core'` | `core`, `plugin`, `channel` or `mcp`                             |
| `provenance_signer_id` | `TEXT`                             | Signature fields; checking them is off by default                |
| `provenance_signature` | `TEXT`                             |                                                                  |
| `provenance_signed_at` | `INTEGER`                          |                                                                  |
| `enabled`              | `INTEGER`, not null, default `1`   | `0` makes the broker refuse the tool (`denied: disabled:<name>`) |
| `connector_id`         | `TEXT`                             | The connector the tool came from; null for a builtin             |
| `created_at`           | `INTEGER`, not null                |                                                                  |
| `updated_at`           | `INTEGER`, not null                |                                                                  |

Indexes: `idx_tool_registry_owner` (`owner`), `idx_tool_registry_connector` (`connector_id`).

### tool_call_audit

Append-only audit of every brokered call, written before and after it runs. Arguments and results are scrubbed of secrets before they are stored; the model still gets the real result.

| Column           | Type                             | Notes                                                              |
| ---------------- | -------------------------------- | ------------------------------------------------------------------ |
| `id`             | `TEXT`, PK                       |                                                                    |
| `tool_name`      | `TEXT`, not null                 |                                                                    |
| `agent_id`       | `TEXT`                           |                                                                    |
| `phase`          | `TEXT`, not null                 | `before` or `after`                                                |
| `decision`       | `TEXT`                           | On `before` rows: `allow`, `deny`, `require_approval` or `rewrite` |
| `args_summary`   | `TEXT`                           | Scrubbed JSON                                                      |
| `result_summary` | `TEXT`                           | Scrubbed and shortened result                                      |
| `is_error`       | `INTEGER`, not null, default `0` |                                                                    |
| `tenant_id`      | `TEXT`                           | Unused                                                             |
| `grant_id`       | `TEXT`                           | The grant the call was decided under; null for builtins            |
| `connector_id`   | `TEXT`                           | The call's connector; null for builtins                            |
| `rule_id`        | `TEXT`                           | The remembered rule that decided it, if any                        |
| `created_at`     | `INTEGER`, not null              |                                                                    |

Indexes: `idx_tool_audit_tool` (`tool_name`), `idx_tool_audit_created` (`created_at`), `idx_tool_audit_grant` (`grant_id`, `created_at`).

### tool_call_approvals

Approval requests. `kind: 'tool'` is a call Clawboo itself is holding (the broker, a Clawboo Native agent's command, or a delegation). `kind: 'exec'` mirrors a shell command the OpenClaw Gateway is holding: its row id is the Gateway's request id, `tool_name` is `exec`, `tool_class` is `destructive`, and `args_summary` is `{ command, cwd }`.

| Column           | Type                                  | Notes                                                                                                                                              |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | `TEXT`, PK                            |                                                                                                                                                    |
| `tool_name`      | `TEXT`, not null                      |                                                                                                                                                    |
| `agent_id`       | `TEXT`                                |                                                                                                                                                    |
| `args_summary`   | `TEXT`                                | Scrubbed JSON                                                                                                                                      |
| `reason`         | `TEXT`                                | Why it needs approval                                                                                                                              |
| `status`         | `TEXT`, not null, default `'pending'` | `pending`, `allow_once`, `allow_always`, `deny` or `expired`                                                                                       |
| `task_id`        | `TEXT`                                | Plain reference to `tasks.id`, so an expired approval can unblock its task                                                                         |
| `tenant_id`      | `TEXT`                                | Unused                                                                                                                                             |
| `grant_id`       | `TEXT`                                | The connector grant the call was checked against                                                                                                   |
| `connector_id`   | `TEXT`                                |                                                                                                                                                    |
| `never_remember` | `INTEGER`, not null, default `0`      | `1` when "Always" must not be offered                                                                                                              |
| `rule_reason`    | `TEXT`                                | Why the grant asked: `policy-always`, `policy-writes`, `risk-destructive`, `risk-external`, `lethal-trifecta`, `tainted-run` or `never-remembered` |
| `tool_class`     | `TEXT`                                | `read`, `write` or `destructive`                                                                                                                   |
| `tool_summary`   | `TEXT`                                | The tool's own one-line description (for `exec`, the first 200 characters of the command)                                                          |
| `kind`           | `TEXT`, not null, default `'tool'`    | `tool` or `exec`                                                                                                                                   |
| `created_at`     | `INTEGER`, not null                   |                                                                                                                                                    |
| `expires_at`     | `INTEGER`, not null                   | When the waiting call stops waiting; 5 minutes after creation for broker calls                                                                     |
| `resolved_at`    | `INTEGER`                             |                                                                                                                                                    |

Indexes: `idx_tool_approvals_status` (`status`), `idx_tool_approvals_created` (`created_at`), `idx_tool_approvals_grant` (`grant_id`, `status`).

### tool_result_blobs

Tool results too large to hand a model whole (over 16 KiB). The model gets a trimmed view and a `tr_` handle that `read_tool_result` reads back. One result keeps at most 8 MiB. Rows older than 7 days are deleted (`CLAWBOO_TOOL_RESULT_TTL_MS`).

| Column         | Type                | Notes                                                              |
| -------------- | ------------------- | ------------------------------------------------------------------ |
| `handle`       | `TEXT`, PK          | An unguessable `tr_` id                                            |
| `tool_name`    | `TEXT`, not null    |                                                                    |
| `agent_id`     | `TEXT`              |                                                                    |
| `tenant_id`    | `TEXT`              | Unused                                                             |
| `body`         | `TEXT`, not null    |                                                                    |
| `total_bytes`  | `INTEGER`, not null | What the tool produced                                             |
| `stored_bytes` | `INTEGER`, not null | What was kept; less than `total_bytes` when the 8 MiB limit cut it |
| `created_at`   | `INTEGER`, not null |                                                                    |

Indexes: `idx_tool_result_blobs_created` (`created_at`).

### approval_history

A log of approval decisions posted to `POST /api/approvals`.

| Column       | Type                             | Notes                                  |
| ------------ | -------------------------------- | -------------------------------------- |
| `id`         | `INTEGER`, PK, autoincrement     |                                        |
| `agent_id`   | `TEXT`, not null, FK `agents.id` |                                        |
| `action`     | `TEXT`, not null                 | `allow-once`, `allow-always` or `deny` |
| `tool_name`  | `TEXT`, not null                 |                                        |
| `details`    | `TEXT`                           | JSON                                   |
| `created_at` | `INTEGER`, not null              |                                        |

Indexes: `idx_approval_history_agent_id` (`agent_id`), `idx_approval_history_created_at` (`created_at`).

## Connectors and grants

Connectors Clawboo runs, and the grants that decide which agents may use them. See [Connectors](/using/connectors).

### connectors

One row per connector Clawboo has connected, written only after the connector answered. No secret is stored: `spec` holds only `secret:NAME` references.

| Column          | Type                                    | Notes                                                                                                                    |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`            | `TEXT`, PK                              |                                                                                                                          |
| `slug`          | `TEXT`, not null                        |                                                                                                                          |
| `catalog_id`    | `TEXT`                                  | The connector directory entry; null for one you added yourself                                                           |
| `display_name`  | `TEXT`, not null                        |                                                                                                                          |
| `transport`     | `TEXT`, not null                        | `stdio` or `streamable-http`                                                                                             |
| `spec`          | `TEXT`, not null, default `'{}'`        | JSON launch or connection spec                                                                                           |
| `spec_hash`     | `TEXT`, not null                        | SHA-256 of the spec, for drift checks                                                                                    |
| `tools_hash`    | `TEXT`                                  | SHA-256 of the tool list, for drift checks                                                                               |
| `egress_allow`  | `TEXT`, not null, default `'[]'`        | JSON array of hosts it may reach                                                                                         |
| `trifecta`      | `TEXT`, not null, has a default         | JSON `{ readsPrivateData, ingestsUntrustedContent, canEgress }`; all `false` by default                                  |
| `health`        | `TEXT`, not null, default `'unknown'`   | `unknown`, `ok`, `needs-auth`, `degraded`, `error` or `drift`. Set to `ok` on connect and `error` when its process exits |
| `desired_state` | `TEXT`, not null, default `'connected'` | `connected` or `disconnected`: whether you left it on. A start restores only `connected` ones                            |
| `health_detail` | `TEXT`                                  |                                                                                                                          |
| `failures`      | `INTEGER`, not null, default `0`        | Consecutive failures                                                                                                     |
| `tenant_id`     | `TEXT`                                  | Unused                                                                                                                   |
| `created_at`    | `INTEGER`, not null                     |                                                                                                                          |
| `updated_at`    | `INTEGER`, not null                     |                                                                                                                          |

Indexes: `uniq_connectors_slug` (unique: `slug`), `idx_connectors_health` (`health`), `idx_connectors_catalog` (`catalog_id`).

### capability_grants

Grants: one row lets an agent, a team or every agent use a connector, tool or skill, and is also the edge the graph draws. There is no last-used column; that comes from `tool_call_audit`.

| Column                  | Type                                   | Notes                                                                                              |
| ----------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                    | `TEXT`, PK                             |                                                                                                    |
| `grant_key`             | `TEXT`, not null                       | The canonical (subject, capability) pair; unique, so one grant per pair                            |
| `subject_kind`          | `TEXT`, not null                       | `agent`, `team` or `global`                                                                        |
| `subject_id`            | `TEXT`                                 | Null for `global`                                                                                  |
| `capability_kind`       | `TEXT`, not null                       | `connector`, `tool` or `skill`                                                                     |
| `connector_id`          | `TEXT`                                 | Set for a connector grant (then `capability_id` is null)                                           |
| `capability_id`         | `TEXT`                                 |                                                                                                    |
| `tool_allow`            | `TEXT`, not null, default `'["*"]'`    | JSON glob list                                                                                     |
| `tool_deny`             | `TEXT`, not null, default `'[]'`       | JSON glob list                                                                                     |
| `mode`                  | `TEXT`, not null, default `'read'`     | `read`, `write` or `admin`                                                                         |
| `approval_policy`       | `TEXT`, not null, default `'risk'`     | `never`, `risk`, `writes` or `always`                                                              |
| `state`                 | `TEXT`, not null, default `'active'`   | `proposed`, `active`, `suspended`, `revoked` or `expired`                                          |
| `origin`                | `TEXT`, not null, default `'operator'` | `owner` (the runtime already attaches it; not drawn as an edge) or `operator` (a person shared it) |
| `expires_at`            | `INTEGER`                              |                                                                                                    |
| `spec_hash_pin`         | `TEXT`                                 | The connector spec hash approved; a mismatch denies calls (`spec-drift`)                           |
| `tools_hash_pin`        | `TEXT`                                 | The tool list hash approved                                                                        |
| `call_ceiling_per_hour` | `INTEGER`                              | Hourly call limit; null for none                                                                   |
| `granted_by`            | `TEXT`                                 |                                                                                                    |
| `granted_at`            | `INTEGER`, not null                    |                                                                                                    |
| `revoked_at`            | `INTEGER`                              |                                                                                                    |
| `revoked_reason`        | `TEXT`                                 |                                                                                                    |
| `tenant_id`             | `TEXT`                                 | Unused                                                                                             |
| `created_at`            | `INTEGER`, not null                    |                                                                                                    |
| `updated_at`            | `INTEGER`, not null                    |                                                                                                    |

Indexes: `uniq_capability_grants_key` (unique: `grant_key`), `idx_grants_subject` (`subject_kind`, `subject_id`), `idx_grants_connector` (`connector_id`), `idx_grants_capability` (`capability_id`), `idx_grants_state` (`state`), `idx_grants_expires` (`expires_at`).

### approval_rules

Remembered **Always** decisions, each bound to a grant. Revoking the grant deletes its rules in the same step (there is no foreign key). A rule made from **Always** expires after 30 days.

| Column                     | Type                | Notes                                                                    |
| -------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `id`                       | `TEXT`, PK          |                                                                          |
| `rule_key`                 | `TEXT`, not null    | The canonical (grant, tool, argument shape) triple; unique               |
| `grant_id`                 | `TEXT`, not null    | Plain reference to `capability_grants.id`                                |
| `tool_name`                | `TEXT`, not null    |                                                                          |
| `args_shape`               | `TEXT`              | Null covers any arguments; a value limits the rule to one argument shape |
| `decision`                 | `TEXT`, not null    | `allow` or `deny`                                                        |
| `created_from_approval_id` | `TEXT`              | The approval it came from                                                |
| `expires_at`               | `INTEGER`, not null | Required; a rule never lasts forever                                     |
| `tenant_id`                | `TEXT`              | Unused                                                                   |
| `created_at`               | `INTEGER`, not null |                                                                          |

Indexes: `uniq_approval_rules_key` (unique: `rule_key`), `idx_approval_rules_grant` (`grant_id`), `idx_approval_rules_expires` (`expires_at`).

## Capabilities and skills

### capabilities

Every runtime's skills, tools and connectors in one list, which the **Capabilities** panel and the graph read. Each source re-reads its own rows without touching another source's.

| Column          | Type                                | Notes                                                                                                                                                             |
| --------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `TEXT`, PK                          | `<source_id>:<key>`, so the id is the upsert key                                                                                                                  |
| `source_id`     | `TEXT`, not null                    | The source that read it: `native`, `claude-code`, `codex`, `hermes`, `openclaw` or `connector`                                                                    |
| `source_key`    | `TEXT`, not null                    | The item's own name in that source                                                                                                                                |
| `kind`          | `TEXT`, not null                    | `skill`, `tool` or `connector`                                                                                                                                    |
| `runtime`       | `TEXT`, not null                    | The runtime it belongs to                                                                                                                                         |
| `scope`         | `TEXT`, not null                    | `team`, `agent` or `global`                                                                                                                                       |
| `agent_id`      | `TEXT`                              | Null for `team` and `global` scope                                                                                                                                |
| `origin`        | `TEXT`, not null                    | Where it was read from: `brokered-mcp`, `curated-skill`, `filesystem-skill-md`, `mcp-connector`, `runtime-builtin`, `openclaw-extension` or `external-vendor-cli` |
| `manageability` | `TEXT`, not null                    | `managed`, `external-write`, `runtime-of-record` or `observe-only`                                                                                                |
| `name`          | `TEXT`, not null                    |                                                                                                                                                                   |
| `description`   | `TEXT`, not null, default `''`      |                                                                                                                                                                   |
| `availability`  | `TEXT`                              | JSON requirement, or null                                                                                                                                         |
| `available`     | `INTEGER`, not null, default `1`    | `1` when its requirement is met                                                                                                                                   |
| `diagnostics`   | `TEXT`, not null, default `'[]'`    | JSON array of strings                                                                                                                                             |
| `provenance`    | `TEXT`                              | JSON, or null                                                                                                                                                     |
| `status`        | `TEXT`, not null, default `'ready'` | `ready`, `disabled`, `manageable-but-pending-auth` or `unavailable`                                                                                               |
| `tenant_id`     | `TEXT`                              | Unused                                                                                                                                                            |
| `synced_at`     | `INTEGER`, not null                 | When its source last read it                                                                                                                                      |
| `created_at`    | `INTEGER`, not null                 |                                                                                                                                                                   |
| `updated_at`    | `INTEGER`, not null                 |                                                                                                                                                                   |

Indexes: `idx_capabilities_source` (`source_id`), `idx_capabilities_runtime` (`runtime`), `idx_capabilities_agent` (`agent_id`), `idx_capabilities_kind` (`kind`).

### skills

Skills added to agents from the Marketplace or the Capabilities panel.

| Column         | Type             | Notes                                                      |
| -------------- | ---------------- | ---------------------------------------------------------- |
| `id`           | `TEXT`, PK       |                                                            |
| `name`         | `TEXT`, not null |                                                            |
| `source`       | `TEXT`, not null | `curated` or `capability`                                  |
| `category`     | `TEXT`           |                                                            |
| `trust_score`  | `REAL`           | Not written                                                |
| `installed_at` | `INTEGER`        | Epoch milliseconds                                         |
| `metadata`     | `TEXT`           | JSON, including `agentIds`, the agents that have the skill |

Indexes: `idx_skills_source` (`source`), `idx_skills_category` (`category`).

## Peer room and mailbox

The agents' peer room behind the TeamChat MCP server, and each agent's mailbox. Neither is the dashboard's team chat.

### team_chat

Posts in the agents' peer room. A post never changes the board. The table has no `tenant_id` column.

| Column            | Type                               | Notes                                                             |
| ----------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `id`              | `TEXT`, PK                         |                                                                   |
| `room_id`         | `TEXT`, not null                   | `team:<teamId>`; never a `rooms.id`                               |
| `team_id`         | `TEXT`, not null                   |                                                                   |
| `author_agent_id` | `TEXT`, not null                   | Taken from the poster's signed binding, never from tool arguments |
| `body`            | `TEXT`, not null                   |                                                                   |
| `kind`            | `TEXT`, not null, default `'peer'` | `peer` (a teammate), `system` (board narration) or `user`         |
| `created_at`      | `INTEGER`, not null                |                                                                   |
| `seq`             | `INTEGER`, not null                | Position in the room, counting up from 1                          |

Indexes: `uniq_team_chat_room_seq` (unique: `room_id`, `seq`), `idx_team_chat_team` (`team_id`).

### agent_inbox

Each agent's mailbox of coordination notices. A notice is delivered once, by whichever channel reaches the agent first (the digest at the start of a run, or the MCP tool-result piggyback). Undelivered notices survive restarts.

| Column          | Type                | Notes                                                                                            |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `id`            | `TEXT`, PK          |                                                                                                  |
| `team_id`       | `TEXT`              |                                                                                                  |
| `agent_id`      | `TEXT`, not null    | The recipient                                                                                    |
| `kind`          | `TEXT`, not null    | `task_update` (a delegated task finished), `alert` (a coordination failure) or `signal` (an FYI) |
| `body`          | `TEXT`, not null    |                                                                                                  |
| `task_id`       | `TEXT`              |                                                                                                  |
| `created_at`    | `INTEGER`, not null |                                                                                                  |
| `delivered_at`  | `INTEGER`           | Null while pending                                                                               |
| `delivered_via` | `TEXT`              | `digest`, `mcp` or `signal`                                                                      |
| `tenant_id`     | `TEXT`              | Unused                                                                                           |

Indexes: `idx_agent_inbox_pending` (`agent_id`, `delivered_at`).

## Spend, budgets and audit

### cost_records

Per-agent token and spend records, which the **Tokens Used** panel reads. Rows come from `POST /api/cost-records`, from the server watching OpenClaw sessions, and from each Clawboo Native, Claude Code, Codex or Hermes run when the server settles its cost (task-runner and team-chat runs).

| Column          | Type                             | Notes                                                                      |
| --------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `id`            | `INTEGER`, PK, autoincrement     |                                                                            |
| `agent_id`      | `TEXT`, not null, FK `agents.id` |                                                                            |
| `model`         | `TEXT`, not null                 |                                                                            |
| `input_tokens`  | `INTEGER`, not null              |                                                                            |
| `output_tokens` | `INTEGER`, not null              |                                                                            |
| `cost_usd`      | `REAL`, not null                 | US dollars                                                                 |
| `run_id`        | `TEXT`                           | The run it belongs to                                                      |
| `session_key`   | `TEXT`                           | The conversation it belongs to; null on rows from `POST /api/cost-records` |
| `created_at`    | `INTEGER`, not null              |                                                                            |

Indexes: `idx_cost_records_agent_id` (`agent_id`), `idx_cost_records_session` (`session_key`, `created_at`), `idx_cost_records_run_id` (`run_id`), `idx_cost_records_created_at` (`created_at`).

### budgets

Spend budgets. Spend is tracked in whole and fractional cents so many tiny charges still add up. The default `mode` is `warn` (track and warn); `cap` (pause at 100%) is opt-in. See [Budgets and spend](/using/budgets-and-spend).

| Column              | Type                                 | Notes                                                                                            |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `id`                | `TEXT`, PK                           |                                                                                                  |
| `scope`             | `TEXT`, not null                     | `agent`, `mission` (a root task and its subtasks), `team`, or `tenant` (accepted, never charged) |
| `scope_id`          | `TEXT`, not null                     |                                                                                                  |
| `limit_usd_cents`   | `INTEGER`, not null                  | The limit, in cents                                                                              |
| `spent_usd_cents`   | `INTEGER`, not null, default `0`     | Spend in whole cents                                                                             |
| `spent_micro_cents` | `INTEGER`, not null, default `0`     | Spend in ten-thousandths of a cent                                                               |
| `status`            | `TEXT`, not null, default `'active'` | `active`, `soft_capped` or `paused`                                                              |
| `mode`              | `TEXT`, not null, default `'warn'`   | `warn` (warn at 80% and 100%, never pause) or `cap` (pause at 100%)                              |
| `tenant_id`         | `TEXT`                               | Unused                                                                                           |
| `created_at`        | `INTEGER`, not null                  |                                                                                                  |
| `updated_at`        | `INTEGER`, not null                  |                                                                                                  |

Indexes: `uniq_budgets_scope` (unique: `scope`, `scope_id`), `idx_budgets_status` (`status`).

### governance_audit

Append-only audit of governance decisions, with secrets scrubbed.

| Column       | Type                | Notes                                                                     |
| ------------ | ------------------- | ------------------------------------------------------------------------- |
| `id`         | `TEXT`, PK          |                                                                           |
| `event_type` | `TEXT`, not null    | `install`, `approval`, `tool_call`, `budget`, `cap_hit` or `verification` |
| `agent_id`   | `TEXT`              |                                                                           |
| `task_id`    | `TEXT`              |                                                                           |
| `team_id`    | `TEXT`              |                                                                           |
| `tenant_id`  | `TEXT`              | Unused                                                                    |
| `summary`    | `TEXT`, not null    | Scrubbed JSON                                                             |
| `created_at` | `INTEGER`, not null |                                                                           |

Indexes: `idx_gov_audit_agent` (`agent_id`, `created_at`), `idx_gov_audit_created` (`created_at`).

## Event log

### orchestration_events

The append-only event log that observability reads. Kinds and their data are in [Events and errors](/reference/events-and-errors).

| Column           | Type                         | Notes                                                            |
| ---------------- | ---------------------------- | ---------------------------------------------------------------- |
| `seq`            | `INTEGER`, PK, autoincrement | Increases with every row and is never reused, across processes   |
| `id`             | `TEXT`, not null             | Event UUID                                                       |
| `ts`             | `INTEGER`, not null          | When the event happened                                          |
| `kind`           | `TEXT`, not null             | One of the 25 event kinds                                        |
| `team_id`        | `TEXT`                       |                                                                  |
| `task_id`        | `TEXT`                       |                                                                  |
| `agent_id`       | `TEXT`                       |                                                                  |
| `runtime`        | `TEXT`                       |                                                                  |
| `trace_id`       | `TEXT`                       | Set on task-runner runs; shared by every run under one root task |
| `span_id`        | `TEXT`                       |                                                                  |
| `parent_span_id` | `TEXT`                       |                                                                  |
| `correlation_id` | `TEXT`                       |                                                                  |
| `data`           | `TEXT`, not null             | Scrubbed JSON payload                                            |
| `tenant_id`      | `TEXT`                       | Unused                                                           |
| `created_at`     | `INTEGER`, not null          |                                                                  |

Indexes: `uniq_orch_events_id` (unique: `id`), `idx_orch_events_team_seq` (`team_id`, `seq`), `idx_orch_events_task_seq` (`task_id`, `seq`), `idx_orch_events_trace_seq` (`trace_id`, `seq`), `idx_orch_events_kind_ts` (`kind`, `ts`), `idx_orch_events_created` (`created_at`).

## Settings and layout

### settings

Key and value rows for most dashboard settings and for Clawboo's own state, including the per-install secret that signs MCP attach URLs (`mcp-attach-scope-secret`). What the rows hold is listed in [Configuration](/reference/configuration).

| Column       | Type                | Notes |
| ------------ | ------------------- | ----- |
| `key`        | `TEXT`, PK          |       |
| `value`      | `TEXT`, not null    |       |
| `updated_at` | `INTEGER`, not null |       |

No indexes beyond the primary key.

### graph_layouts

Saved node positions for the graphs. `name` is `atlas-radial` or `atlas-top-down` for the Org chart, `team-<teamId>` for a team graph, `team-<teamId>-room-<roomId>` for a room graph, and `default` with no team selected.

| Column        | Type                                  | Notes                                           |
| ------------- | ------------------------------------- | ----------------------------------------------- |
| `id`          | `INTEGER`, PK, autoincrement          |                                                 |
| `name`        | `TEXT`, not null, default `'default'` | The layout name                                 |
| `gateway_url` | `TEXT`, not null                      | The Gateway URL in use; empty without a Gateway |
| `layout_data` | `TEXT`, not null                      | JSON node and edge positions                    |
| `created_at`  | `INTEGER`, not null                   |                                                 |
| `updated_at`  | `INTEGER`, not null                   |                                                 |

Indexes: `uniq_graph_layouts_name_url` (unique: `name`, `gateway_url`).

## Full-text search

Keyword search over facts uses `memory_facts_fts`, an FTS5 virtual table with the columns `title`, `content` and `fact_id` (`fact_id` is stored but not indexed). The same schema definition creates it, and it is not counted among the 35 tables. Three triggers keep it in step with `memory_facts`:

| Trigger           | Runs         | Does                                        |
| ----------------- | ------------ | ------------------------------------------- |
| `memory_facts_ai` | After insert | Adds the new fact to the search table       |
| `memory_facts_ad` | After delete | Removes the fact from the search table      |
| `memory_facts_au` | After update | Replaces the fact's row in the search table |

## How the schema is created

There is no migration ladder: no numbered migration files, no `user_version` bookkeeping, and no `db:migrate` script. The `CREATE TABLE IF NOT EXISTS` statements in `packages/db/src/schemaBootstrap.ts` are the only place tables, indexes and triggers are created. `packages/db/src/schema.ts` is the Drizzle type layer for typed queries; it never changes the database. Contributor rules for schema changes are in [Monorepo and build](/internals/monorepo-and-build).

### Upgrading an existing database

When the server starts, it brings the file up to the current schema in one transaction:

1. It compares each existing table's columns with the schema definition and adds any column the file is missing (`ALTER TABLE ... ADD COLUMN`, using the column's definition from the same source).
2. It then runs the definition, which creates any missing table, index or trigger.

Columns go first because a new column usually comes with a new index on it. If any step fails, the transaction rolls back and the file stays exactly as it was. The one start that adds columns logs `SQLite: added missing columns to an existing database`.

Nothing else changes in an existing database:

- A column whose type, `NOT NULL` or `DEFAULT` changed keeps its old definition. Only new databases get the new one, and nothing reports the difference.
- A column the definition no longer declares stays in place. That is also what an older Clawboo sees when it opens a newer database, so leaving the column keeps the newer version's data.
- A changed index or trigger is skipped, because `IF NOT EXISTS` matches on the name. New table constraints and changes to the full-text table are not applied either.

Clawboo never drops, rebuilds or resets a table to apply a change. A change of those kinds reaches only databases created after it.

A column added to an existing table must be one SQLite can add in place: no `PRIMARY KEY`, `UNIQUE` or `STORED` generated column; a literal `DEFAULT`, not an expression such as `CURRENT_TIMESTAMP`; a `DEFAULT` on every `NOT NULL` column; and no non-null `DEFAULT` on a `REFERENCES` column. If such a column ever reached a user, the start would stop before changing the file. The server keeps running without a usable database, and **System Health** shows the `databaseSchema` check as failed with `SQLite schema cannot be upgraded in place` and an error naming the column. Tests catch such a column before release.

The other `databaseSchema` failures are `core tables missing` and `schema is missing <n> column(s); queries touching them will fail`.

## Connection settings

Every connection opens with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 250;
PRAGMA wal_autocheckpoint = 50;
```

Several processes can open the file at once, for example the server and a stdio MCP bin pointed at it. Board writes take the write lock up front (`BEGIN IMMEDIATE`) and retry with jitter for up to 1.5 seconds (`CLAWBOO_DB_WRITE_BUDGET_MS`), which is why `busy_timeout` is short. The server holds one connection for as long as it runs, and on shutdown it checkpoints the write-ahead log into the main file (`wal_checkpoint(TRUNCATE)`) before closing.

## Where the file lives

- The dashboard server uses `clawboo.db` in its data folder: `~/.clawboo/clawboo.db`, or the folder `CLAWBOO_HOME` names.
- The stdio MCP bins use `CLAWBOO_DB_PATH`, or `~/.openclaw/clawboo/clawboo.db` when it is unset; `CLAWBOO_DB_PATH` affects only the bins. To make a bin share the dashboard's database, set `CLAWBOO_DB_PATH` to the dashboard's file. The stdio snippets from `GET /api/mcp/config` do this.
- On open, Clawboo sets the folder to `0700` and the database and its `-wal` and `-shm` files to `0600`, because the file holds the secret that signs MCP attach URLs. Where that fails (for example on Windows, or for a file another user owns), Clawboo logs a warning and opens the file anyway.
- At start, **System Health** runs `PRAGMA integrity_check` (`databaseIntegrity`) and the schema check above (`databaseSchema`).

## Related

- [Data and state](/operating/data-and-state): where Clawboo keeps its files, and how to back up and reset.
- [Configuration](/reference/configuration): what the `settings` rows hold.
- [Events and errors](/reference/events-and-errors): the event kinds stored in `orchestration_events`.
- [MCP tools](/reference/mcp-tools): the tools that read and write the board and memory tables.
- [Monorepo and build](/internals/monorepo-and-build): the rules for changing the schema.
