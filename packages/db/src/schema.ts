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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_teams_name').on(t.name)],
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
// unused. `tenant_id` is a dormant seam for a future multi-tenant / Postgres swap.

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
  },
  (t) => [
    index('idx_tasks_team_status').on(t.teamId, t.status),
    index('idx_tasks_assignee').on(t.assigneeAgentId),
    index('idx_tasks_parent').on(t.parentTaskId),
    // Serves BOTH guarded-create counts, which run while the write lock is held:
    // the per-parent child count (`parent_task_id = ? AND dropped = 0`, an index
    // prefix) and the root-rate count (`parent_task_id IS NULL AND dropped = 0 AND
    // created_at > ?`, equality-equality-range, so the range column comes last).
    // Without it that second count scans every non-dropped root and stalls all task
    // writes on a board with a long history. `idx_tasks_parent` is kept: dropping it
    // from this DDL would not drop it from databases that already have it.
    index('idx_tasks_parent_dropped_created').on(t.parentTaskId, t.dropped, t.createdAt),
  ],
)

export type DbTask = typeof tasks.$inferSelect
export type DbTaskInsert = typeof tasks.$inferInsert

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
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_task_comments_task').on(t.taskId)],
)

export type DbTaskComment = typeof taskComments.$inferSelect
export type DbTaskCommentInsert = typeof taskComments.$inferInsert

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
    // queued | running | succeeded | failed | timed_out | cancelled
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
    summary: text('summary'),
    runReason: text('run_reason'),
    error: text('error'),
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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('idx_memory_facts_team').on(t.scopeTeamId),
    index('idx_memory_facts_agent').on(t.scopeAgentId),
    index('idx_memory_facts_created').on(t.createdAt),
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
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_memory_procedures_name').on(t.name),
    index('idx_memory_procedures_team').on(t.scopeTeamId),
  ],
)

export type DbMemoryProcedure = typeof memoryProcedures.$inferSelect
export type DbMemoryProcedureInsert = typeof memoryProcedures.$inferInsert

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
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_tool_registry_owner').on(t.owner)],
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
    // The board task this approval gates, when known (so the TTL reaper can
    // unblock it on expiry). Nullable — tool-call approvals carry no task.
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
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [
    index('idx_tool_approvals_status').on(t.status),
    index('idx_tool_approvals_created').on(t.createdAt),
    index('idx_tool_approvals_grant').on(t.grantId, t.status),
  ],
)

export type DbToolCallApproval = typeof toolCallApprovals.$inferSelect
export type DbToolCallApprovalInsert = typeof toolCallApprovals.$inferInsert

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
    // 'alert' = a coordination failure (parked, delivery-exhausted) ·
    // 'signal' = an FYI peer event worth ambient delivery.
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    taskId: text('task_id'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
    /** Which channel delivered it ('digest' | 'mcp' | 'signal'). */
    deliveredVia: text('delivered_via'),
    tenantId: text('tenant_id'),
  },
  (t) => [index('idx_agent_inbox_pending').on(t.agentId, t.deliveredAt)],
)

export type DbAgentInboxRow = typeof agentInbox.$inferSelect

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
