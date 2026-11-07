import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// ─── chat_messages ────────────────────────────────────────────────────────────
// Persisted transcript entries so chat history survives page refresh.
// Keyed by entryId (UUID) to allow idempotent batch inserts.

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionKey: text('session_key').notNull(),
    gatewayUrl: text('gateway_url').notNull(),
    entryId: text('entry_id').notNull(),
    timestampMs: integer('timestamp_ms').notNull(),
    /** JSON-serialised TranscriptEntry — full payload for easy reconstruction. */
    data: text('data').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_chat_messages_entry_id').on(t.entryId),
    index('idx_chat_messages_session_ts').on(t.sessionKey, t.timestampMs),
    // The (session_key, id) tail index for the live SSE stream: each poll
    // range-seeks `id > cursor` per team member key — O(new-rows), not O(history).
    index('idx_chat_messages_session_id').on(t.sessionKey, t.id),
  ],
)

export type DbChatMessage = typeof chatMessages.$inferSelect
export type DbChatMessageInsert = typeof chatMessages.$inferInsert

// ─── teams ────────────────────────────────────────────────────────────────────
// Groups of agents deployed together. Each team has a name, icon (emoji),
// and color. Optional templateId links to the team profile template used.

export const teams = sqliteTable(
  'teams',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    icon: text('icon').notNull(),
    color: text('color').notNull(),
    colorCollectionId: text('color_collection_id'),
    templateId: text('template_id'),
    leaderAgentId: text('leader_agent_id'),
    isArchived: integer('is_archived').notNull().default(0),
    tenantId: text('tenant_id'), // dormant multi-tenant seam (single implicit tenant)
    // The letters on the team's readable task ids (`CLB` in `CLB-12`), unique across
    // the workspace. NULL until a person sets it or the team's first task takes it;
    // fixed from that first task on, whatever the team is renamed to.
    taskPrefix: text('task_prefix'),
    // The number the team's next task takes.
    nextTaskNumber: integer('next_task_number').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_teams_name').on(t.name),
    uniqueIndex('idx_teams_task_prefix').on(t.taskPrefix),
  ],
)

export type DbTeam = typeof teams.$inferSelect
export type DbTeamInsert = typeof teams.$inferInsert

// ─── agents ───────────────────────────────────────────────────────────────────
// The agent registry-of-record (AgentSource decoupling). `OpenClawAgentSource`
// syncs the Gateway's agents INTO this table; SQLite then serves reads (so they
// work even when the Gateway is down). Columns split into Gateway-synced
// (name/status/identityJson/sourceAgentId — overwritten on every sync) and
// SQLite-native (teamId/personality/execConfig/avatarSeed/participantKind/runtime/
// capabilities/tenantId — clawboo-owned, preserved across re-sync). `name` +
// `gatewayId` are kept as legacy denormalized columns (== displayName base /
// sourceAgentId) for back-compat with existing FK readers.

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    gatewayId: text('gateway_id').notNull(),
    avatarSeed: text('avatar_seed'),
    personalityConfig: text('personality_config'), // JSON: slider values
    execConfig: text('exec_config'), // JSON: { execAsk, execSecurity }
    teamId: text('team_id').references(() => teams.id),
    status: text('status').notNull().default('idle'),
    // ── AgentSource decoupling ──
    sourceId: text('source_id').notNull().default('openclaw'), // which AgentSource owns it
    sourceAgentId: text('source_agent_id'), // upstream id (== gatewayId; backfilled on first sync)
    identityJson: text('identity_json'), // JSON: Gateway identity (name/emoji/avatarUrl/theme)
    participantKind: text('participant_kind').notNull().default('agent'), // 'agent' | 'human' (dormant)
    runtime: text('runtime').notNull().default('openclaw'), // open-set runtime id (dormant)
    capabilities: text('capabilities'), // JSON capability hints (dormant)
    tenantId: text('tenant_id'), // dormant multi-tenant seam
    archivedAt: integer('archived_at'), // soft-delete tombstone (epoch ms; null = live)
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_agents_gateway_id').on(t.gatewayId),
    index('idx_agents_status').on(t.status),
    index('idx_agents_team_id').on(t.teamId),
    index('idx_agents_source').on(t.sourceId, t.sourceAgentId),
  ],
)

// ─── sessions ───────────────────────────────────────────────────────────────────
// Dormant seam for the future native runtime: a native AgentSource will own its
// sessions here. For OpenClaw, sessions stay Gateway-live (`listSessions` delegates
// to the Gateway) and this table is inert in Phase A. Soft-ref `agentId` (no FK)
// follows the board precedent — session/agent ids are upstream-owned.

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull().default('openclaw'),
    sourceSessionId: text('source_session_id').notNull(),
    agentId: text('agent_id'),
    teamId: text('team_id'),
    status: text('status').notNull().default('idle'),
    // Predecessor session id when this row is a rotation successor (session-
    // rotation lineage). Soft self-ref (no FK) — mirrors the board precedent.
    parentSessionId: text('parent_session_id'),
    runtime: text('runtime'),
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_sessions_source').on(t.sourceId, t.sourceSessionId),
    index('idx_sessions_agent').on(t.agentId),
    index('idx_sessions_parent').on(t.parentSessionId),
  ],
)

export type DbSession = typeof sessions.$inferSelect
export type DbSessionInsert = typeof sessions.$inferInsert

// ─── cost_records ─────────────────────────────────────────────────────────────

export const costRecords = sqliteTable(
  'cost_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    runId: text('run_id'),
    /**
     * Which conversation this spend belongs to.
     *
     * Needed to RESUME billing after a restart. The tracker is seeded from the
     * last recorded spend so a restart does not re-bill a live turn, and without
     * a session key that lookup could return a row from a different session of
     * the same agent and seed the tracker with an unrelated cumulative snapshot.
     * Nullable: rows written before this existed have no answer, and inventing
     * one would be worse than admitting it.
     */
    sessionKey: text('session_key'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_cost_records_agent_id').on(t.agentId),
    index('idx_cost_records_run_id').on(t.runId),
    index('idx_cost_records_created_at').on(t.createdAt),
  ],
)

// ─── graph_layouts ────────────────────────────────────────────────────────────

export const graphLayouts = sqliteTable(
  'graph_layouts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().default('default'),
    gatewayUrl: text('gateway_url').notNull(),
    layoutData: text('layout_data').notNull(), // JSON: node + edge positions
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('uniq_graph_layouts_name_url').on(t.name, t.gatewayUrl)],
)

// ─── settings ─────────────────────────────────────────────────────────────────

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

// ─── skills ───────────────────────────────────────────────────────────────────

export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    source: text('source').notNull(), // free-text provenance (e.g. 'curated' | 'capability'); not an external registry
    category: text('category'),
    trustScore: real('trust_score'),
    installedAt: integer('installed_at'),
    metadata: text('metadata'), // JSON
  },
  (t) => [index('idx_skills_source').on(t.source), index('idx_skills_category').on(t.category)],
)

// ─── team_profiles ────────────────────────────────────────────────────────────

export const teamProfiles = sqliteTable('team_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  agentsConfig: text('agents_config').notNull(), // JSON: array of agent definitions
  skillsConfig: text('skills_config').notNull(), // JSON: array of skill refs
  graphLayout: text('graph_layout'), // JSON: node positions
  isBuiltin: integer('is_builtin').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

// ─── boo_zero_team_briefs ─────────────────────────────────────────────────────
// Per-team context briefs that Boo Zero (the universal team leader) reads
// when operating on a team. One row per team. Content is markdown.
//
// Backs the SQLite-first "virtual file" model — surfaced as editable docs in
// the UI, injected into Boo Zero's context preamble at runtime.
//
// FK cascades on team delete so we don't leak orphaned briefs.

export const booZeroTeamBriefs = sqliteTable('boo_zero_team_briefs', {
  teamId: text('team_id')
    .primaryKey()
    .references(() => teams.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type DbBooZeroTeamBrief = typeof booZeroTeamBriefs.$inferSelect
export type DbBooZeroTeamBriefInsert = typeof booZeroTeamBriefs.$inferInsert

// ─── rooms + room_members ─────────────────────────────────────────────────────
// Extra chat rooms inside ONE team, each a subset of the team's members. The
// team's own group chat is the implicit default room and has no row (room id
// NULL wherever a room id appears), so its history never moved. Team rules,
// brief, memory and the board stay team-wide. A room is archived, never
// deleted: its transcript stays readable under its session keys.
//
// Membership is a table rather than a JSON list on the room: the room FK
// cascades it away, the PK dedupes it, the agent FK sweeps it when an agent row
// is deleted, and an edit is a set-replace in one transaction instead of a
// read-modify-write of a blob.

export const rooms = sqliteTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tenantId: text('tenant_id'), // dormant multi-tenant seam
    archivedAt: integer('archived_at'),
    pinnedAt: integer('pinned_at'), // pinned to the top of the sidebar's room list (epoch ms)
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_rooms_team').on(t.teamId)],
)

export type DbRoom = typeof rooms.$inferSelect
export type DbRoomInsert = typeof rooms.$inferInsert

export const roomMembers = sqliteTable(
  'room_members',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references((): AnySQLiteColumn => agents.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.agentId] }),
    index('idx_room_members_agent').on(t.agentId),
  ],
)

export type DbRoomMember = typeof roomMembers.$inferSelect

// ─── approval_history ─────────────────────────────────────────────────────────

export const approvalHistory = sqliteTable(
  'approval_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    action: text('action').notNull(), // 'allow_once' | 'always_allow' | 'deny'
    toolName: text('tool_name').notNull(),
    details: text('details'), // JSON
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_approval_history_agent_id').on(t.agentId),
    index('idx_approval_history_created_at').on(t.createdAt),
  ],
)

// ─── Durable board ──────────────────────────────────────────────
// The transactional source of truth for team/task coordination state. Net-new
// state category (distinct from the Gateway-owned agent/session registry — the
// board only references agents/runtimes by id, never duplicates them). All flag-
// gated at the route + reconciliation layer; the tables themselves are inert when
// unused. `tenant_id` is a dormant seam (always null).

// tasks — the kanban cards. Soft refs (no FK) to team/agent/runtime/session/
// delegation since those are Gateway- or chat-store-owned; only the internal
// parent_task_id self-reference is FK-enforced.
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    // backlog | todo | in_progress | in_review | blocked | done | cancelled
    status: text('status').notNull().default('backlog'),
    priority: integer('priority').notNull().default(0),
    teamId: text('team_id'),
    assigneeAgentId: text('assignee_agent_id'),
    assigneeRuntime: text('assignee_runtime'), // 'openclaw' | 'claude-code' | 'codex' | …
    parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id),
    sourceDelegationId: text('source_delegation_id'),
    worktreeRef: text('worktree_ref'),
    branchRef: text('branch_ref'),
    costUsd: real('cost_usd').notNull().default(0),
    parentSessionId: text('parent_session_id'),
    dropped: integer('dropped').notNull().default(0), // soft-delete
    tenantId: text('tenant_id'), // dormant multi-tenant seam
    // The one-TEAM-TASK-firing-owner label: which scheduler fires this task.
    // Open-set: 'manual' (hand-created) | 'clawboo' (the Routines engine) |
    // 'openclaw' | future runtimes. Exactly one owner per team task; the
    // registration-time de-dup guard in routines/ enforces it.
    scheduledBy: text('scheduled_by').notNull().default('manual'),
    // Typed VerificationResult JSON. null until a gate runs;
    // the `in_review → done` gate reads `.status === 'pass'` from this cell.
    verification: text('verification'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
    // The chat room the task was delegated in (see `rooms`). NULL = the team's own
    // group chat (the default room), which is every task created before rooms.
    roomId: text('room_id'),
    // When a person last moved the card (the board, the task drawer). A run that
    // started before then was overruled, so an agent's own status write from it
    // is refused (see `updateStatus`'s `unlessPersonMoved`).
    personMovedAt: integer('person_moved_at'),
    // What the task runner was given for the task's latest run (JSON
    // `TaskRunnerInputs`, see board/runnerInputs.ts), so a person's Retry or
    // Assign runs it the same way again. NULL for a task the runner never ran.
    runnerInputs: text('runner_inputs'),
    // What the task waits for, as a JSON `WaitingOn` (@clawboo/board-core): the
    // reason a Blocked or In review task is not moving. NULL when it waits on
    // nothing, or a bare move gave no reason.
    waitingOn: text('waiting_on'),
    // The person it is assigned to, beside `assigneeAgentId` and never with it. The
    // id is a sign-in proxy's subject or the built-in local person; there is no
    // people table, so it is plain text with the JSON {id, name, role} kept beside it.
    assigneePersonId: text('assignee_person_id'),
    assigneePerson: text('assignee_person'),
    // The person who asked for it, as a JSON {id, name, role}: who a hand-back goes
    // to. NULL for a task an agent or the engine made.
    requestedBy: text('requested_by'),
    // The readable id, like `CLB-12` (see board/identifiers.ts), unique across the
    // workspace. NULL for a task with no team, or whose team is gone.
    identifier: text('identifier'),
    // The agent that handed the task out through the Tasks tools. The team engine
    // records its delegator in `source_delegation_id` instead. The cycle guard
    // reads both (see `handOffChain`).
    delegatedByAgentId: text('delegated_by_agent_id'),
    // When a person cancelled it, itself or as a step waiting on one they cancelled.
    // Only this frees the task's slot under its parent: an agent that could free
    // slots by cancelling its own children could create without limit.
    personCancelledAt: integer('person_cancelled_at'),
    // While a team-chat check waits for other runs to leave the team folder: when
    // it began waiting. NULL otherwise. Read only while the task is `in_review`,
    // and any move out of review clears it (see `updateStatus`).
    checkHeldSince: integer('check_held_since'),
    // The execution holding this task's claim: written in the same transaction as
    // the claim, moved to a fix round's execution, and cleared when the run ends or
    // the task is let go. Null while no run holds it (a claim that opened no run).
    runExecutionId: text('run_execution_id'),
    // A person's request from the chat: the main task the helpers' work is filed
    // under (see board/repository.ts). It holds no run of its own and nothing fires it.
    isMainTask: integer('is_main_task').notNull().default(0),
    // The one-to-one chat it was handed off from (its session key): the task shows
    // as a card there, and its result goes back there through report_up_outbox.
    // NULL for a task from anywhere else.
    chatSessionKey: text('chat_session_key'),
  },
  (t) => [
    index('idx_tasks_team_status').on(t.teamId, t.status),
    index('idx_tasks_status').on(t.status),
    index('idx_tasks_team_room').on(t.teamId, t.roomId),
    index('idx_tasks_assignee').on(t.assigneeAgentId),
    index('idx_tasks_parent').on(t.parentTaskId),
    index('idx_tasks_chat_session').on(t.chatSessionKey, t.updatedAt),
    // Serves BOTH guarded-create counts, which run while the write lock is held:
    // the per-parent child count (`parent_task_id = ? AND dropped = 0`, an index
    // prefix) and the root-rate count (`parent_task_id IS NULL AND dropped = 0 AND
    // created_at > ?`, equality-equality-range, so the range column comes last).
    // Without it that second count scans every non-dropped root and stalls all task
    // writes on a board with a long history. `idx_tasks_parent` is kept: dropping it
    // from this DDL would not drop it from databases that already have it.
    index('idx_tasks_parent_dropped_created').on(t.parentTaskId, t.dropped, t.createdAt),
    index('idx_tasks_assignee_person').on(t.assigneePersonId),
    uniqueIndex('idx_tasks_identifier').on(t.identifier),
  ],
)

export type DbTask = typeof tasks.$inferSelect
export type DbTaskInsert = typeof tasks.$inferInsert

// task_create_keys: what makes a create safe to repeat. One row per idempotency
// key: the same key again returns this task instead of making another. A separate
// table so that a task the same-title check returned can answer to the key of the
// create it stood in for as well as its own. `derived` marks a key the server made
// up from the run and the title: it holds for 48 hours and not over a blocked task,
// where a caller's own key holds for good.
export const taskCreateKeys = sqliteTable('task_create_keys', {
  key: text('key').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  derived: integer('derived').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

export type DbTaskCreateKey = typeof taskCreateKeys.$inferSelect

// delegation_failures: the team engine's loop breaker: how many times in a row
// one agent failed one task. In the database so a restart or an unloaded engine
// does not hand a failing loop three more tries. `task_key` is the start of the
// ask, as the engine compares it. A soft ref to the team, as on `tasks`.
export const delegationFailures = sqliteTable(
  'delegation_failures',
  {
    teamId: text('team_id').notNull(),
    targetAgentId: text('target_agent_id').notNull(),
    taskKey: text('task_key').notNull(),
    failures: integer('failures').notNull().default(0),
    notifiedAt: integer('notified_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.targetAgentId, t.taskKey] })],
)

export type DbDelegationFailure = typeof delegationFailures.$inferSelect

// labels + task_labels: a team's own words for sorting its board. `name_key` is
// the name as compared (see board/labels.ts), so `Bug` and `bug` are one label.
export const labels = sqliteTable(
  'labels',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_labels_team_name').on(t.teamId, t.nameKey)],
)

export type DbLabel = typeof labels.$inferSelect

export const taskLabels = sqliteTable(
  'task_labels',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.labelId] }),
    index('idx_task_labels_label').on(t.labelId),
  ],
)

export type DbTaskLabel = typeof taskLabels.$inferSelect

// task_deps — the blocks / blocked-by dependency graph (Beads-style). Composite
// PK prevents duplicate edges.
export const taskDeps = sqliteTable(
  'task_deps',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    dependsOnTaskId: text('depends_on_task_id')
      .notNull()
      .references(() => tasks.id),
    tenantId: text('tenant_id'),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    index('idx_task_deps_task').on(t.taskId),
    index('idx_task_deps_depends').on(t.dependsOnTaskId),
  ],
)

export type DbTaskDep = typeof taskDeps.$inferSelect
export type DbTaskDepInsert = typeof taskDeps.$inferInsert

// task_questions: what an agent asked a person about a task, and the answer. The
// answer and who gave it are written together, judged against expiry inside that
// write. Expiry is on events (the task closing or moving on, a newer question).
export const taskQuestions = sqliteTable(
  'task_questions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    teamId: text('team_id'),
    // The agent that asked.
    agentId: text('agent_id'),
    // question | confirm | suggest_tasks
    kind: text('kind').notNull(),
    // JSON QuestionPayload (@clawboo/board-core).
    payload: text('payload').notNull(),
    // pending | answered | expired | cancelled
    status: text('status').notNull().default('pending'),
    // Set by the asker so a repeated call asks once; cleared when the question closes
    // unanswered, so asking again really asks. A plain column with a separate
    // unique index, per task.
    idempotencyKey: text('idempotency_key'),
    // The execution row of the run that asked, when an agent's run did.
    executionId: text('execution_id'),
    // JSON QuestionAnswer.
    answer: text('answer'),
    // Who answered: a JSON {id, name, role}.
    answeredBy: text('answered_by'),
    // Why it closed unanswered: replaced | task_closed | moved | stopped.
    closeReason: text('close_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    answeredAt: integer('answered_at'),
  },
  (t) => [
    index('idx_task_questions_task').on(t.taskId, t.status),
    uniqueIndex('idx_task_questions_idempotency').on(t.taskId, t.idempotencyKey),
  ],
)

export type DbTaskQuestion = typeof taskQuestions.$inferSelect

// task_documents: documents on a task, in revisions. Today only its plan.
export const taskDocuments = sqliteTable(
  'task_documents',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    teamId: text('team_id'),
    // What the document is: only 'plan' today.
    key: text('key').notNull(),
    // 1, 2, 3 for a task and key. A new revision is a new row: none is overwritten.
    revision: integer('revision').notNull(),
    body: text('body').notNull(),
    authorAgentId: text('author_agent_id'),
    // The run that wrote it, when an agent's run did.
    executionId: text('execution_id'),
    // The question that asks a person about this revision, if one has.
    questionId: text('question_id'),
    // accepted | declined, once a person answered: what makes an acceptance happen once.
    decision: text('decision'),
    // Who decided: a JSON {id, name, role}.
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('idx_task_documents_revision').on(t.taskId, t.key, t.revision)],
)

export type DbTaskDocument = typeof taskDocuments.$inferSelect

// task_comments — per-task discussion / system notes.
export const taskComments = sqliteTable(
  'task_comments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    authorAgentId: text('author_agent_id'),
    authorType: text('author_type').notNull(), // 'agent' | 'user' | 'system'
    body: text('body').notNull(),
    tenantId: text('tenant_id'),
    /** The person whose request added it, when a sign-in proxy vouched for
     *  them: a JSON `{ id, name, role }`. Null otherwise. */
    person: text('person'),
    /** What wrote it, as the writer labelled it (`CommentKind` in board-core):
     *  'person' | 'agent' | 'note' | 'result'. Never read from `authorType`. Null
     *  for a caller that gave none and for an older row: such a comment wakes no one. */
    kind: text('kind'),
    /** When it was steered into a run that took it live. A session resumed from that
     *  run has heard it, so its next ticket block leaves it out. */
    steeredAt: integer('steered_at'),
    /** The execution row of the run that wrote it, when an agent's run did. Null
     *  for anything else, and for an agent's turn with no execution row. */
    executionId: text('execution_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_task_comments_task').on(t.taskId)],
)

export type DbTaskComment = typeof taskComments.$inferSelect
export type DbTaskCommentInsert = typeof taskComments.$inferInsert

// task_activity: each task's newest change a person could want to know about.
// Written only by the triggers in schemaBootstrap.ts. See board/readState.ts.
export const taskActivity = sqliteTable(
  'task_activity',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    taskId: text('task_id').notNull(),
    kind: text('kind').notNull(), // 'created' | 'status' | 'edited' | 'comment'
    at: integer('at').notNull(),
  },
  (t) => [uniqueIndex('uniq_task_activity_task').on(t.taskId)],
)

export type DbTaskActivity = typeof taskActivity.$inferSelect

// task_readers: how far each reader has read across the whole board.
export const taskReaders = sqliteTable('task_readers', {
  readerId: text('reader_id').primaryKey(), // 'local' | 'person:<id>'
  baselineSeq: integer('baseline_seq').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export type DbTaskReader = typeof taskReaders.$inferSelect

// task_reads: the newest change a reader has read on one task.
export const taskReads = sqliteTable(
  'task_reads',
  {
    readerId: text('reader_id').notNull(),
    taskId: text('task_id').notNull(),
    readSeq: integer('read_seq').notNull(),
    readAt: integer('read_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.readerId, t.taskId] })],
)

export type DbTaskRead = typeof taskReads.$inferSelect

// workspaces — per-task git worktree isolation.
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    repoPath: text('repo_path').notNull(),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    status: text('status').notNull().default('active'), // active | archived | stale
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('idx_workspaces_task').on(t.taskId)],
)

export type DbWorkspace = typeof workspaces.$inferSelect
export type DbWorkspaceInsert = typeof workspaces.$inferInsert

// execution_processes — one spawned run for a task (any executor). Records git
// checkpoints (before/after commit) + token/cost ledger + the recovery tombstone
// that makes orphan reconciliation idempotent (no infinite auto-resume).
export const executionProcesses = sqliteTable(
  'execution_processes',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    executorType: text('executor_type').notNull(), // 'openclaw' | 'claude-code' | 'codex' | …
    // The runtime that actually ran, when executor_type records an owner rather than
    // a runtime: the team engine types every fire 'openclaw'. Null means executor_type
    // is the runtime.
    runtime: text('runtime'),
    // Whether the team engine owns this run: 1 or 0. Null on a row from before this
    // column, which only the engine labelled 'openclaw'. Read through `isEngineRun` in
    // board-core, never from the label.
    engineRun: integer('engine_run'),
    // queued | running | succeeded | failed | timed_out | cancelled, or the host
    // stopping it: budget_paused | budget_held | breaker_tripped. Free-form: a reader
    // that switches on it must name these (see `runKindOf` in @clawboo/board-core).
    status: text('status').notNull().default('queued'),
    claimedAt: integer('claimed_at'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    beforeCommit: text('before_commit'),
    afterCommit: text('after_commit'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheRead: integer('cache_read'),
    cacheWrite: integer('cache_write'),
    costUsd: real('cost_usd'),
    // How cost_usd was obtained: 'reported' | 'local' | 'token-estimate' | 'char-estimate'
    // (see RUN_COST_SOURCES). Null when no cost is recorded, or when it predates this column.
    costSource: text('cost_source'),
    summary: text('summary'),
    runReason: text('run_reason'),
    error: text('error'),
    // The class the failure was filed under (`classifyError` in @clawboo/obs).
    // Null for a run that did not fail, or one closed without a class.
    errorClass: text('error_class'),
    // Whether the run made visible progress (`runMadeProgress` in board-core), read
    // when it closed: 1 or 0. Null for a run with no verdict (a Stop, an account or
    // budget refusal) and for a row from before this column. The no-progress brake
    // counts these, so they outlive a restart.
    madeProgress: integer('made_progress'),
    /** 1: this run took one from its job's count. A run refused before it started gives
     *  it back. */
    jobCounted: integer('job_counted'),
    /** What the run's agent said about its task (`report_result`), as JSON. Evidence:
     *  `decideDone` in @clawboo/board-core reads it, and it moves nothing itself. */
    resultClaim: text('result_claim'),
    recoveryTombstone: integer('recovery_tombstone').notNull().default(0),
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_exec_task').on(t.taskId), index('idx_exec_status').on(t.status)],
)

export type DbExecutionProcess = typeof executionProcesses.$inferSelect
export type DbExecutionProcessInsert = typeof executionProcesses.$inferInsert

// scheduled_runs — the Routines ledger: durable team-task schedules (the
// external wake for every runtime class). The row is the source of truth; the
// in-process ticker is a rebuildable actuator (boot-resume re-arms from
// next_run_at). Soft ref to agents/teams (board precedent). `next_run_at`
// NULL = disarmed (spent once@ / paused / errored). See src/routines/.
export const scheduledRuns = sqliteTable(
  'scheduled_runs',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    teamId: text('team_id'),
    // A croner cron expression or 'once@<iso>' for one-shots.
    cronSpec: text('cron_spec').notNull(),
    // TaskTemplate JSON (validated at the registration boundary).
    taskTemplate: text('task_template').notNull(),
    // idle | queued | claimed | running | paused | error
    status: text('status').notNull().default('idle'),
    lastRunAt: integer('last_run_at'),
    nextRunAt: integer('next_run_at'),
    // Open-set firing owner; this engine writes 'clawboo'.
    scheduledBy: text('scheduled_by').notNull().default('clawboo'),
    lastError: text('last_error'),
    // Failed fires in a row. A routine keeps its schedule through failures that
    // may pass (rate limit, timeout, provider outage) until this reaches the cap.
    failureStreak: integer('failure_streak').notNull().default(0),
    tenantId: text('tenant_id'), // dormant multi-tenant seam
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_scheduled_runs_next').on(t.nextRunAt),
    index('idx_scheduled_runs_status_next').on(t.status, t.nextRunAt),
    index('idx_scheduled_runs_agent').on(t.agentId),
  ],
)

export type DbScheduledRun = typeof scheduledRuns.$inferSelect
export type DbScheduledRunInsert = typeof scheduledRuns.$inferInsert

// ─── MCP trifecta — Memory ────────────────────────────────────────
// 2-tier memory: declarative facts + versioned procedures. FTS5 search is via a
// companion virtual table (`memory_facts_fts`, raw DDL in db.ts — Drizzle can't
// model a virtual table) kept in sync by triggers. The optional `embedding` BLOB
// (little-endian Float32) powers the vector / hybrid search modes; null when no
// embedding provider is configured (graceful FTS fallback). `tenant_id` dormant.

export const memoryFacts = sqliteTable(
  'memory_facts',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    tags: text('tags').notNull().default('[]'), // JSON string[]
    embedding: blob('embedding'), // Float32 LE BLOB; null = no vector
    embeddingModel: text('embedding_model'), // provider id that produced it
    scopeAgentId: text('scope_agent_id'),
    scopeTeamId: text('scope_team_id'),
    tenantId: text('tenant_id'),
    // Provenance (who/what produced this row) — nullable, write-time only,
    // never affects visibility scoping. 'user' runtime = saved from the UI.
    createdByAgentId: text('created_by_agent_id'),
    createdByRuntime: text('created_by_runtime'),
    sourceTaskId: text('source_task_id'),
    sourceSessionKey: text('source_session_key'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_memory_facts_team').on(t.scopeTeamId),
    index('idx_memory_facts_agent').on(t.scopeAgentId),
    index('idx_memory_facts_created').on(t.createdAt),
    index('idx_memory_facts_model_created').on(t.embeddingModel, t.createdAt, t.id),
  ],
)

export type DbMemoryFact = typeof memoryFacts.$inferSelect
export type DbMemoryFactInsert = typeof memoryFacts.$inferInsert

export const memoryProcedures = sqliteTable(
  'memory_procedures',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    content: text('content').notNull(),
    scopeAgentId: text('scope_agent_id'),
    scopeTeamId: text('scope_team_id'),
    tenantId: text('tenant_id'),
    createdByAgentId: text('created_by_agent_id'),
    createdByRuntime: text('created_by_runtime'),
    sourceTaskId: text('source_task_id'),
    sourceSessionKey: text('source_session_key'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_memory_procedures_name').on(t.name),
    index('idx_memory_procedures_team').on(t.scopeTeamId),
  ],
)

export type DbMemoryProcedure = typeof memoryProcedures.$inferSelect
export type DbMemoryProcedureInsert = typeof memoryProcedures.$inferInsert

// Outcome signals against facts — the substrate of the derived learning overlay
// (packages/db/src/memory/learning.ts). One table for explicit feedback
// (useful/dead_end/corrected) AND internal citation events ('cited', written
// only by the auto-injection path — external zod enums exclude it, so usage
// counts cannot be forged). fact_id is a soft ref (no FK — memory posture).
export const memoryOutcomes = sqliteTable(
  'memory_outcomes',
  {
    id: text('id').primaryKey(),
    factId: text('fact_id').notNull(),
    outcome: text('outcome').notNull(), // 'useful' | 'dead_end' | 'corrected' | 'cited'
    note: text('note'),
    agentId: text('agent_id'),
    teamId: text('team_id'),
    taskId: text('task_id'),
    runtime: text('runtime'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_memory_outcomes_fact').on(t.factId),
    index('idx_memory_outcomes_created').on(t.createdAt),
  ],
)

export type DbMemoryOutcome = typeof memoryOutcomes.$inferSelect
export type DbMemoryOutcomeInsert = typeof memoryOutcomes.$inferInsert

// ─── MCP trifecta — Tools broker ──────────────────────────────────
// The brokered tool layer that supersedes the markdown-bullet skill model. The
// registry persists descriptor metadata + the provenance seam (signature verify
// is real but enforcement is off by default). Every call is audited (args/result
// scrubbed of secrets). Risky calls open a DB-mediated approval the UI resolves.

export const toolRegistry = sqliteTable(
  'tool_registry',
  {
    name: text('name').primaryKey(),
    description: text('description').notNull(),
    inputSchema: text('input_schema'), // JSON Schema (serialised)
    availability: text('availability'), // JSON availability requirement
    owner: text('owner').notNull().default('core'), // core | plugin | channel | mcp
    provenanceSignerId: text('provenance_signer_id'),
    provenanceSignature: text('provenance_signature'),
    provenanceSignedAt: integer('provenance_signed_at'),
    enabled: integer('enabled').notNull().default(1),
    /** The connector this tool was discovered from. Null for a builtin. */
    connectorId: text('connector_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_tool_registry_owner').on(t.owner),
    index('idx_tool_registry_connector').on(t.connectorId),
  ],
)

export type DbToolRegistry = typeof toolRegistry.$inferSelect
export type DbToolRegistryInsert = typeof toolRegistry.$inferInsert

export const toolCallAudit = sqliteTable(
  'tool_call_audit',
  {
    id: text('id').primaryKey(),
    toolName: text('tool_name').notNull(),
    agentId: text('agent_id'),
    phase: text('phase').notNull(), // 'before' | 'after'
    decision: text('decision'), // allow | deny | require_approval | rewrite (before)
    argsSummary: text('args_summary'), // scrubbed JSON
    resultSummary: text('result_summary'), // scrubbed + compacted (after)
    isError: integer('is_error').notNull().default(0),
    tenantId: text('tenant_id'),
    // Grant attribution. Null for a core builtin, which no grant governs.
    grantId: text('grant_id'),
    connectorId: text('connector_id'),
    ruleId: text('rule_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_tool_audit_tool').on(t.toolName),
    index('idx_tool_audit_created').on(t.createdAt),
    // Backs lastUsedByGrant, which is why capability_grants has no last_used_at.
    index('idx_tool_audit_grant').on(t.grantId, t.createdAt),
  ],
)

export type DbToolCallAudit = typeof toolCallAudit.$inferSelect
export type DbToolCallAuditInsert = typeof toolCallAudit.$inferInsert

export const toolCallApprovals = sqliteTable(
  'tool_call_approvals',
  {
    id: text('id').primaryKey(),
    toolName: text('tool_name').notNull(),
    agentId: text('agent_id'),
    argsSummary: text('args_summary'), // scrubbed JSON
    reason: text('reason'),
    // pending | allow_once | allow_always | deny | expired
    status: text('status').notNull().default('pending'),
    // The board task the asking run works on, when it works on one: named on the
    // card and in the approval events. Nothing moves the task when the approval
    // expires. Nullable: a 1:1 chat or a lead's own turn has no task.
    taskId: text('task_id'),
    tenantId: text('tenant_id'),
    grantId: text('grant_id'),
    connectorId: text('connector_id'),
    // 1 when the tool has no scopable argument shape, which is what makes
    // "Always" unofferable. Persisted so the resolve path cannot mint a durable
    // rule the prompt never offered.
    neverRemember: integer('never_remember').notNull().default(0),
    // The GrantApprovalReason behind the prompt, e.g. lethal-trifecta.
    ruleReason: text('rule_reason'),
    /** The server's own reading of the tool: read | write | destructive. */
    toolClass: text('tool_class'),
    /** The tool's own one-line description, for a card that cannot name the verb. */
    toolSummary: text('tool_summary'),
    /**
     * WHO holds the call while the human decides: `tool` (clawboo's own broker,
     * blocking inside `waitForApproval`) or `exec` (an OpenClaw shell command,
     * held by the Gateway; clawboo only mirrors and answers it).
     *
     * EXPLICIT RATHER THAN INFERRED. The two are resolved by different means — a
     * broker approval releases a local promise, an exec approval is answered with
     * `exec.approval.resolve` over the Gateway — so a resolver that guessed from
     * a null `connector_id` or a tool named "exec" would silently do the wrong
     * one the first time either assumption stopped holding.
     */
    kind: text('kind').notNull().default('tool'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    resolvedAt: integer('resolved_at'),
    /** Who answered it, when a sign-in proxy vouched for them: a JSON
     *  `{ id, name, role }` (a PersonRef). Null when nothing did. */
    resolvedBy: text('resolved_by'),
  },
  (t) => [
    index('idx_tool_approvals_status').on(t.status),
    index('idx_tool_approvals_created').on(t.createdAt),
    index('idx_tool_approvals_grant').on(t.grantId, t.status),
  ],
)

export type DbToolCallApproval = typeof toolCallApprovals.$inferSelect
export type DbToolCallApprovalInsert = typeof toolCallApprovals.$inferInsert

// Tool results too large to hand a model in one piece, kept whole. See the DDL in
// schemaBootstrap for why storing precedes trimming.
export const toolResultBlobs = sqliteTable(
  'tool_result_blobs',
  {
    handle: text('handle').primaryKey(),
    toolName: text('tool_name').notNull(),
    agentId: text('agent_id'),
    tenantId: text('tenant_id'),
    body: text('body').notNull(),
    /** What the tool produced, which exceeds `storedBytes` when the store capped it. */
    totalBytes: integer('total_bytes').notNull(),
    storedBytes: integer('stored_bytes').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_tool_result_blobs_created').on(t.createdAt)],
)

export type DbToolResultBlob = typeof toolResultBlobs.$inferSelect

// ─── Governance ────────────────────────────────────────────
// Hard USD budget kill-switch + append-only forensic audit. Budgets are scoped
// (agent / mission(root task) / team; `tenant` is a dormant seam) with cent-exact
// integer spend so the atomic read-modify-write never drifts. `governance_audit`
// is insert-only (no update/delete writer), secrets scrubbed before storage, and
// indexed by `(agent_id, created_at)` for lineage queries.

export const budgets = sqliteTable(
  'budgets',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(), // 'agent' | 'mission' | 'team' | 'tenant'
    scopeId: text('scope_id').notNull(),
    limitUsdCents: integer('limit_usd_cents').notNull(),
    spentUsdCents: integer('spent_usd_cents').notNull().default(0),
    // Lossless spend accumulator in micro-cents (ten-thousandths of a cent):
    // sub-cent cost events carry here so repeated tiny amounts are not floored to
    // 0. `spentUsdCents` above is the whole-cent display mirror = floor(micro/10000).
    spentMicroCents: integer('spent_micro_cents').notNull().default(0),
    status: text('status').notNull().default('active'), // active | soft_capped | paused
    // 'cap'  = hard cap: auto-pause the run at 100% (the budget kill-switch).
    // 'warn' = track-and-warn (the DEFAULT posture): record spend + emit a warning
    //          event at the 80% / 100% crossings, but NEVER auto-pause. A hard cap
    //          is opt-in.
    mode: text('mode').notNull().default('warn'),
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_budgets_scope').on(t.scope, t.scopeId),
    index('idx_budgets_status').on(t.status),
  ],
)

export type DbBudget = typeof budgets.$inferSelect
export type DbBudgetInsert = typeof budgets.$inferInsert

// pauses: a person's durable pause of an agent, a team or a task tree (its root
// task's id), which every run start reads. A row means paused; resuming deletes it.
export const pauses = sqliteTable(
  'pauses',
  {
    id: text('id').primaryKey(),
    scopeKind: text('scope_kind').notNull(), // agent | team | task_tree
    scopeId: text('scope_id').notNull(),
    reason: text('reason'),
    // JSON { id, name, role }, from a sign-in proxy; null for the local person.
    pausedBy: text('paused_by'),
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('uniq_pauses_scope').on(t.scopeKind, t.scopeId)],
)

export type DbPause = typeof pauses.$inferSelect

// What a run that is going expects to spend, set aside on each budget it counts
// toward until it ends (see governance/reservations.ts). One row per (hold, budget).
export const budgetReservations = sqliteTable(
  'budget_reservations',
  {
    id: text('id').primaryKey(),
    holdId: text('hold_id').notNull(),
    budgetId: text('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    // Still set aside: the estimate less what the run has spent so far, never below 0.
    heldMicroCents: integer('held_micro_cents').notNull().default(0),
    estimateMicroCents: integer('estimate_micro_cents').notNull().default(0),
    runKind: text('run_kind').notNull(), // 'task' | 'team-chat' | 'chat' | 'routine' | 'exchange'
    runRef: text('run_ref'),
    // The server process holding it, for the boot sweep. Null: no owner recorded.
    ownerPid: integer('owner_pid'),
    ownerStartedAt: integer('owner_started_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_budget_reservations_hold').on(t.holdId, t.budgetId),
    index('idx_budget_reservations_budget').on(t.budgetId),
  ],
)

export type DbBudgetReservation = typeof budgetReservations.$inferSelect

export const governanceAudit = sqliteTable(
  'governance_audit',
  {
    id: text('id').primaryKey(),
    // install | approval | tool_call | budget | cap_hit | verification
    eventType: text('event_type').notNull(),
    agentId: text('agent_id'),
    taskId: text('task_id'),
    teamId: text('team_id'),
    tenantId: text('tenant_id'),
    summary: text('summary').notNull(), // scrubbed JSON
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_gov_audit_agent').on(t.agentId, t.createdAt),
    index('idx_gov_audit_created').on(t.createdAt),
  ],
)

export type DbGovernanceAudit = typeof governanceAudit.$inferSelect
export type DbGovernanceAuditInsert = typeof governanceAudit.$inferInsert

// ─── Observability event log ──────────────────────────────────────
// Append-only orchestration event stream — the always-on local TRACE store (a
// trace = events sharing a `trace_id`, ordered by `seq`), the GRAPH-projection
// source, and the metric + error-taxonomy source. `seq` is `INTEGER PRIMARY KEY
// AUTOINCREMENT` so ordering is monotonic + never-reused across MULTIPLE writers
// (the Express server + the MCP stdio bins open the same file). Insert-only by
// discipline (no update/delete writer), `data` scrubbed before storage. See
// src/events/.
export const orchestrationEvents = sqliteTable(
  'orchestration_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(),
    teamId: text('team_id'),
    taskId: text('task_id'),
    agentId: text('agent_id'),
    runtime: text('runtime'),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    parentSpanId: text('parent_span_id'),
    correlationId: text('correlation_id'),
    data: text('data').notNull(), // scrubbed JSON
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_orch_events_id').on(t.id),
    index('idx_orch_events_team_seq').on(t.teamId, t.seq),
    index('idx_orch_events_task_seq').on(t.taskId, t.seq),
    index('idx_orch_events_trace_seq').on(t.traceId, t.seq),
    index('idx_orch_events_kind_ts').on(t.kind, t.ts),
    index('idx_orch_events_created').on(t.createdAt),
  ],
)

export type DbOrchestrationEvent = typeof orchestrationEvents.$inferSelect
export type DbOrchestrationEventInsert = typeof orchestrationEvents.$inferInsert

// ─── Unified capability inventory ─────────────────────────────────────────────
// The durable projection of every runtime's capabilities (skills / tools /
// connectors), read by the five CapabilitySource adapters and fanned by the
// CapabilityMultiplexer. ONE stream drives BOTH the Ghost Graph AND the
// Capabilities dashboard. `id` (`${source_id}:${rawKey}`) deterministically
// encodes the composite identity (source_id, runtime, scope, agent_id, kind,
// source_key) — so the PK IS the upsert key; `source_id` (the owning adapter)
// scopes the read()-reconcile so one source's re-read never deletes another's.
// `tenant_id` is the dormant multi-tenant seam. See src/capabilities/.
export const capabilities = sqliteTable(
  'capabilities',
  {
    id: text('id').primaryKey(),
    // The owning adapter: native | hermes | claude-code | codex | openclaw.
    sourceId: text('source_id').notNull(),
    // The natural identifier inside the owning store (tool name / skill slug).
    sourceKey: text('source_key').notNull(),
    kind: text('kind').notNull(), // skill | tool | connector
    runtime: text('runtime').notNull(), // owning runtime (open set)
    scope: text('scope').notNull(), // team | agent | global
    agentId: text('agent_id'), // null for team/global scope
    // Where it was read from: brokered-mcp | curated-skill | filesystem-skill-md
    // | mcp-connector | runtime-builtin | openclaw-extension | external-vendor-cli
    origin: text('origin').notNull(),
    // managed | external-write | runtime-of-record | observe-only
    manageability: text('manageability').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    availability: text('availability'), // JSON CapabilityAvailability | null
    available: integer('available').notNull().default(1),
    diagnostics: text('diagnostics').notNull().default('[]'), // JSON string[]
    provenance: text('provenance'), // JSON CapabilityProvenance | null
    status: text('status').notNull().default('ready'),
    tenantId: text('tenant_id'), // dormant multi-tenant seam
    syncedAt: integer('synced_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_capabilities_source').on(t.sourceId),
    index('idx_capabilities_runtime').on(t.runtime),
    index('idx_capabilities_agent').on(t.agentId),
    index('idx_capabilities_kind').on(t.kind),
  ],
)

export type DbCapability = typeof capabilities.$inferSelect
export type DbCapabilityInsert = typeof capabilities.$inferInsert

// ─── The grant spine ──────────────────────────────────────────────────────────
// Three nouns kept apart: the catalog TYPE is committed TypeScript in
// @clawboo/connector-catalog, a `connectors` row is a configured INSTANCE, and a
// `capabilities` row is one callable TOOL.
//
// `capability_grants` is the load-bearing one: a row is BOTH the permission
// `executeBrokeredCall` enforces AND the Ghost Graph edge an operator reads. The
// renderer and the gate call the same `decideGrant`, so a badge can never assert
// a denial the runtime would not make.

export const connectors = sqliteTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    catalogId: text('catalog_id'),
    displayName: text('display_name').notNull(),
    transport: text('transport').notNull(), // stdio | streamable-http
    // JSON CanonicalizableSpec. Carries `${secret:NAME}` references, never values.
    spec: text('spec').notNull().default('{}'),
    specHash: text('spec_hash').notNull(),
    toolsHash: text('tools_hash'),
    egressAllow: text('egress_allow').notNull().default('[]'), // JSON string[]
    trifecta: text('trifecta')
      .notNull()
      .default('{"readsPrivateData":false,"ingestsUntrustedContent":false,"canEgress":false}'),
    // A LIVENESS measurement, never an authorization. Nothing writes it in this
    // release; an outbound MCP client is what produces it.
    health: text('health').notNull().default('unknown'),
    // OPERATOR INTENT, not liveness. `health` cannot answer "should this be
    // running": a deliberate disconnect leaves it untouched, and so does a
    // graceful shutdown, so a boot restore reading health would either
    // resurrect a connector the operator switched off or never restore
    // anything. Only an explicit field separates "was on when we stopped" from
    // "turned off on purpose". `connected` is the safe default because a row
    // exists only after a connect succeeded.
    desiredState: text('desired_state').notNull().default('connected'),
    healthDetail: text('health_detail'),
    failures: integer('failures').notNull().default(0),
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_connectors_slug').on(t.slug),
    index('idx_connectors_health').on(t.health),
    index('idx_connectors_catalog').on(t.catalogId),
  ],
)

export type DbConnector = typeof connectors.$inferSelect
export type DbConnectorInsert = typeof connectors.$inferInsert

export const capabilityGrants = sqliteTable(
  'capability_grants',
  {
    id: text('id').primaryKey(),
    // The canonicalised (subject, capability) composite. Uniqueness can only live
    // here: SQLite treats NULLs as distinct, so a UNIQUE over the five nullable
    // identity columns would happily insert the same global grant twice.
    grantKey: text('grant_key').notNull(),
    subjectKind: text('subject_kind').notNull(), // agent | team | global
    subjectId: text('subject_id'),
    capabilityKind: text('capability_kind').notNull(),
    // Agent-INDEPENDENT identity. When set, capabilityId is stored null: a
    // capabilities.id folds the agent id into its key, so a grant keyed on one
    // would be unfindable by the grantee's broker.
    connectorId: text('connector_id'),
    capabilityId: text('capability_id'),
    toolAllow: text('tool_allow').notNull().default('["*"]'), // JSON glob[]
    toolDeny: text('tool_deny').notNull().default('[]'),
    mode: text('mode').notNull().default('read'), // read | write | admin
    approvalPolicy: text('approval_policy').notNull().default('risk'),
    state: text('state').notNull().default('active'),
    // owner    = the runtime config already attaches this connector to this
    //            subject, so the row records what is already true. Never drawn as
    //            an edge: the tile itself is that statement.
    // operator = a human deliberately shared it. This is what draws an edge.
    origin: text('origin').notNull().default('operator'),
    expiresAt: integer('expires_at'),
    specHashPin: text('spec_hash_pin'),
    toolsHashPin: text('tools_hash_pin'),
    callCeilingPerHour: integer('call_ceiling_per_hour'),
    grantedBy: text('granted_by'),
    grantedAt: integer('granted_at').notNull(),
    revokedAt: integer('revoked_at'),
    revokedReason: text('revoked_reason'),
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_capability_grants_key').on(t.grantKey),
    index('idx_grants_subject').on(t.subjectKind, t.subjectId),
    index('idx_grants_connector').on(t.connectorId),
    index('idx_grants_capability').on(t.capabilityId),
    index('idx_grants_state').on(t.state),
    index('idx_grants_expires').on(t.expiresAt),
  ],
)

export type DbCapabilityGrant = typeof capabilityGrants.$inferSelect
export type DbCapabilityGrantInsert = typeof capabilityGrants.$inferInsert

export const approvalRules = sqliteTable(
  'approval_rules',
  {
    id: text('id').primaryKey(),
    ruleKey: text('rule_key').notNull(),
    grantId: text('grant_id').notNull(),
    toolName: text('tool_name').notNull(),
    argsShape: text('args_shape'),
    decision: text('decision').notNull(), // allow | deny
    createdFromApprovalId: text('created_from_approval_id'),
    // NOT NULL on purpose: the rule matcher treats a null expiry as immortal, so
    // "every remembered approval expires" is a policy this column enforces or
    // nothing does.
    expiresAt: integer('expires_at').notNull(),
    tenantId: text('tenant_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_approval_rules_key').on(t.ruleKey),
    index('idx_approval_rules_grant').on(t.grantId),
    index('idx_approval_rules_expires').on(t.expiresAt),
  ],
)

export type DbApprovalRule = typeof approvalRules.$inferSelect
export type DbApprovalRuleInsert = typeof approvalRules.$inferInsert

// ─── team_chat ────────────────────────────────────────────────────────────────
// The durable group-chat room substrate (mixed-runtime peer chat): every team
// member posts as a NAMED PEER into one room. Distinct from the leader-orchestrated
// reflection / issue-comment thread — this is the team's narration transcript. `seq`
// is per-room monotonic (assigned in an immediateWrite tx), so a cursor read
// (`subscribe`) is stable. `teamId` is on every row and the room query is kept
// tenant-scopable (no tenant_id column yet — the dormant multi-tenant seam). The
// board stays canonical: a post NEVER mutates the board.
// agent_inbox — the DURABLE per-agent mailbox (the coordination overhaul's
// delivery plane). A row is a notification an agent must eventually receive:
// an executor-path task update, a parked/undeliverable alert, a peer signal.
// Rows are written by bus subscribers / the orchestrator and consumed by ANY
// channel that touches the agent first — the context digest at run seed, the
// MCP tool-response piggyback mid-run — each marking delivered_at + the channel
// in delivered_via. Undelivered rows survive eviction and restarts: a restart
// is a pause, and the agent catches up from its mailbox, not from luck.
export const agentInbox = sqliteTable(
  'agent_inbox',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id'),
    /** The recipient. */
    agentId: text('agent_id').notNull(),
    // 'task_update' = a delegated/executor task reached a terminal ·
    // 'alert' = a coordination failure (parked, delivery-exhausted).
    // Both ask something of the agent. What a peer says in passing reaches it through
    // the peer room's catch-up instead.
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    taskId: text('task_id'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
    /** Which channel delivered it ('digest' | 'mcp' | 'signal', a steer into its run). */
    deliveredVia: text('delivered_via'),
    tenantId: text('tenant_id'),
    /** Whose words the row quotes: an agent's id or `person`. Null: clawboo's own. */
    source: text('source'),
  },
  (t) => [index('idx_agent_inbox_pending').on(t.agentId, t.deliveredAt)],
)

export type DbAgentInboxRow = typeof agentInbox.$inferSelect

// report_up_outbox: the durable `[Task Update]` outbox. A row is one result the
// engine queued for whoever handed the work off; it stays pending (settled_at
// NULL) until the recipient's run that carried it ends, a Stop drops it, or it is
// given up. The room's next engine replays the pending rows after a restart; a row
// with chat_session_key set belongs to that one-to-one chat instead, which sends it
// itself. See src/reportUps.ts.
export const reportUpOutbox = sqliteTable(
  'report_up_outbox',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull(),
    /** The chat room; null is the team's own group chat. */
    roomId: text('room_id'),
    /** Null resolves to the room's lead when it is sent. */
    recipientAgentId: text('recipient_agent_id'),
    taskId: text('task_id'),
    /** The engine's `ReportUp` item, as JSON. */
    payload: text('payload').notNull(),
    /** Times it was sent again after a restart. */
    replays: integer('replays').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    settledAt: integer('settled_at'),
    /** 'delivered' | 'stopped' | 'gave_up'. */
    settledHow: text('settled_how'),
    /** Set when a person's Stop held it: it starts no run, and it rides the
     *  recipient's next run instead. */
    heldAt: integer('held_at'),
    /** Set when the result goes to a one-to-one chat: the chat's session key. Such a
     *  row is that chat's: no team or room reads it. `team_id` stays the team the
     *  work was done in, so a row whose team is gone is reaped like any other. */
    chatSessionKey: text('chat_session_key'),
  },
  (t) => [
    index('idx_report_up_outbox_pending').on(t.teamId, t.roomId, t.settledAt),
    index('idx_report_up_outbox_chat').on(t.chatSessionKey, t.settledAt),
    index('idx_report_up_outbox_task').on(t.taskId, t.createdAt),
  ],
)

export type DbReportUpOutboxRow = typeof reportUpOutbox.$inferSelect

// task_wakes: something happened on a task and its agent has not heard. A row is
// written when the wake happens (a person's comment, a dependency moving to done),
// and folded into the one that is already waiting for that agent and task, so every
// kind of wake shares one slot. The run that starts the task takes the row
// (`carried_exec_id`), and it is settled when that run ends. A sibling of
// report_up_outbox, and apart from the agent_inbox mailbox, whose rows are spent
// once rendered: a wake counts as heard only when its run ended. See src/taskWakes.ts.
export const taskWakes = sqliteTable(
  'task_wakes',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id'),
    /** The agent the task belonged to when the wake happened. */
    agentId: text('agent_id').notNull(),
    taskId: text('task_id').notNull(),
    /** `TaskWakeReason` in board-core. A merged row keeps the one a person is behind. */
    reason: text('reason').notNull(),
    /** The comments it carries, as a JSON array of ids. */
    commentIds: text('comment_ids').notNull().default('[]'),
    /** How many wakes were folded into this row. */
    mergeCount: integer('merge_count').notNull().default(1),
    /** Times it was sent again because the run carrying it did not finish. */
    replays: integer('replays').notNull().default(0),
    /** The run carrying it. Null while it waits for one. */
    carriedExecId: text('carried_exec_id'),
    /** Why the pump last left it waiting (`WakeSkipReason` in board-core). */
    skipReason: text('skip_reason'),
    /** Set when a person's Stop held it: it starts no run, and it rides the task's
     *  next run instead. */
    heldAt: integer('held_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    settledAt: integer('settled_at'),
    /** `TaskWakeSettlement` in board-core. */
    settledHow: text('settled_how'),
  },
  (t) => [
    // One waiting row per (agent, task). Partial, so a comment during a run opens a
    // new row beside the one that run already carries.
    uniqueIndex('uniq_task_wakes_waiting')
      .on(t.agentId, t.taskId)
      .where(sql`settled_at IS NULL AND carried_exec_id IS NULL`),
    index('idx_task_wakes_pending').on(t.settledAt, t.carriedExecId),
    index('idx_task_wakes_task').on(t.taskId),
  ],
)

export type DbTaskWake = typeof taskWakes.$inferSelect

// ─── Agents waking each other, per job ──────────────────────────────────────
// One row per job (a task's top-level ancestor): what a person said about its agents
// waking each other, the card asking them, and this hour's count. In the database so a
// restart or an evicted engine resets none of it. See board/agentWakes.ts.
export const agentWakeGates = sqliteTable(
  'agent_wake_gates',
  {
    jobTaskId: text('job_task_id').primaryKey(),
    teamId: text('team_id'),
    /** `allow` or `deny`. Null: not asked yet, or not answered. */
    decision: text('decision'),
    /** Who answered: a JSON {id, name, role}. */
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at'),
    /** The card up now: `AgentWakeCardKind` in board-core. Null when there is none. */
    cardKind: text('card_kind'),
    /** The task it shows on, where the wake that raised it is waiting. */
    cardTaskId: text('card_task_id'),
    cardFromAgentId: text('card_from_agent_id'),
    cardToAgentId: text('card_to_agent_id'),
    cardAt: integer('card_at'),
    /** When this hour's count began, and how many wakes it has. */
    windowStartedAt: integer('window_started_at'),
    windowCount: integer('window_count').notNull().default(0),
    /** Who woke whom on this job, in order, as a JSON array of agent ids: what the cycle
     *  check reads (`agentWakeClosesRing` in board-core). */
    wakePath: text('wake_path'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_agent_wake_gates_card').on(t.cardTaskId),
    index('idx_agent_wake_gates_team').on(t.teamId),
  ],
)

export type DbAgentWakeGate = typeof agentWakeGates.$inferSelect

// One row per pair of agents in a team: how many wakes in a row answered each other.
// Per pair and not per job, because a lead's hand-offs are often top-level tasks, so two
// helpers answering each other can be two jobs. See board/agentWakeState.ts.
export const agentWakeChains = sqliteTable(
  'agent_wake_chains',
  {
    /** The team, or an empty string for a task with none. */
    teamKey: text('team_key').notNull(),
    /** The two agents, in sorted order, so a pair has one row either way round. */
    agentA: text('agent_a').notNull(),
    agentB: text('agent_b').notNull(),
    lastFromAgentId: text('last_from_agent_id'),
    chainCount: integer('chain_count').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamKey, t.agentA, t.agentB] })],
)

export type DbAgentWakeChain = typeof agentWakeChains.$inferSelect

/** How many runs a job has started by itself. See `board/jobRuns.ts`. */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    /** The job: a person's main task, or a top-level task. */
    jobTaskId: text('job_task_id').primaryKey(),
    teamId: text('team_id'),
    runs: integer('runs').notNull().default(0),
    /** Where it stops now. A person's "carry on" raises it. */
    runLimit: integer('run_limit').notNull(),
    /** When a start was first refused at the limit, since the last carry on. */
    limitHitAt: integer('limit_hit_at'),
    /** Who said to carry on last: a JSON {id, name, role}. */
    carriedOnBy: text('carried_on_by'),
    carriedOnAt: integer('carried_on_at'),
    /** When a person stopped the job at its limit. Nothing under it starts by itself and
     *  no card is up, until a person starts work in it again. */
    stoppedAt: integer('stopped_at'),
    /** Who stopped it: a JSON {id, name, role}. */
    stoppedBy: text('stopped_by'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_job_runs_hit').on(t.limitHitAt),
    index('idx_job_runs_stopped').on(t.stoppedAt),
    index('idx_job_runs_team').on(t.teamId),
  ],
)

export type DbJobRuns = typeof jobRuns.$inferSelect

export const teamChat = sqliteTable(
  'team_chat',
  {
    id: text('id').primaryKey(),
    // Room id; `team:<teamId>` by default. Kept distinct from teamId so a team
    // could later have >1 room without a schema change (multi-room seam).
    roomId: text('room_id').notNull(),
    teamId: text('team_id').notNull(),
    // Author identity, resolved from the MCP connection binding — never spoofable
    // via tool args. May be a non-runtime participant later (human-as-poster seam).
    authorAgentId: text('author_agent_id').notNull(),
    body: text('body').notNull(),
    // 'peer' = a teammate's post · 'system' = board-mutation narration · 'user'.
    kind: text('kind').notNull().default('peer'),
    createdAt: integer('created_at').notNull(),
    // Per-room monotonic ordering key (MAX(seq)+1 WHERE room_id=? in a write tx).
    seq: integer('seq').notNull(),
  },
  (t) => [
    uniqueIndex('uniq_team_chat_room_seq').on(t.roomId, t.seq),
    index('idx_team_chat_team').on(t.teamId),
  ],
)

export type DbTeamChat = typeof teamChat.$inferSelect
export type DbTeamChatInsert = typeof teamChat.$inferInsert

// ─── Inferred types ───────────────────────────────────────────────────────────

export type DbAgent = typeof agents.$inferSelect
export type DbAgentInsert = typeof agents.$inferInsert
export type DbCostRecord = typeof costRecords.$inferSelect
export type DbCostRecordInsert = typeof costRecords.$inferInsert
export type DbGraphLayout = typeof graphLayouts.$inferSelect
export type DbGraphLayoutInsert = typeof graphLayouts.$inferInsert
export type DbSetting = typeof settings.$inferSelect
export type DbSettingInsert = typeof settings.$inferInsert
export type DbSkill = typeof skills.$inferSelect
export type DbSkillInsert = typeof skills.$inferInsert
export type DbTeamProfile = typeof teamProfiles.$inferSelect
export type DbTeamProfileInsert = typeof teamProfiles.$inferInsert
export type DbApprovalHistory = typeof approvalHistory.$inferSelect
export type DbApprovalHistoryInsert = typeof approvalHistory.$inferInsert
