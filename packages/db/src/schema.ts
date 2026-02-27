import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
  ],
)

export type DbChatMessage = typeof chatMessages.$inferSelect
export type DbChatMessageInsert = typeof chatMessages.$inferInsert

// ─── agents ───────────────────────────────────────────────────────────────────
// UI-only metadata for each OpenClaw agent. Gateway is source of truth for
// status/sessionKey; this table stores avatar seed, personality sliders, etc.

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    gatewayId: text('gateway_id').notNull(),
    avatarSeed: text('avatar_seed'),
    personalityConfig: text('personality_config'), // JSON: slider values
    status: text('status').notNull().default('idle'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('idx_agents_gateway_id').on(t.gatewayId), index('idx_agents_status').on(t.status)],
)

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
    source: text('source').notNull(), // 'clawhub' | 'skill.sh' | 'verified' | 'local'
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
