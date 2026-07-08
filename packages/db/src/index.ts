// ── Schema — tables + indexes + inferred types ─────────────────────────────
export {
  agents,
  approvalHistory,
  booZeroTeamBriefs,
  budgets,
  capabilities,
  chatMessages,
  costRecords,
  executionProcesses,
  governanceAudit,
  graphLayouts,
  memoryFacts,
  memoryProcedures,
  orchestrationEvents,
  scheduledRuns,
  sessions,
  settings,
  skills,
  taskComments,
  taskDeps,
  tasks,
  teamChat,
  teams,
  teamProfiles,
  toolCallApprovals,
  toolCallAudit,
  toolRegistry,
  workspaces,
} from './schema'

export type {
  DbAgent,
  DbAgentInsert,
  DbApprovalHistory,
  DbApprovalHistoryInsert,
  DbBooZeroTeamBrief,
  DbBooZeroTeamBriefInsert,
  DbBudget,
  DbBudgetInsert,
  DbCapability,
  DbCapabilityInsert,
  DbChatMessage,
  DbChatMessageInsert,
  DbCostRecord,
  DbCostRecordInsert,
  DbExecutionProcess,
  DbExecutionProcessInsert,
  DbGovernanceAudit,
  DbGovernanceAuditInsert,
  DbGraphLayout,
  DbGraphLayoutInsert,
  DbSetting,
  DbSettingInsert,
  DbSkill,
  DbSkillInsert,
  DbTask,
  DbTaskComment,
  DbTaskCommentInsert,
  DbTaskDep,
  DbTaskDepInsert,
  DbTaskInsert,
  DbTeam,
  DbTeamInsert,
  DbTeamChat,
  DbTeamChatInsert,
  DbTeamProfile,
  DbTeamProfileInsert,
  DbMemoryFact,
  DbMemoryFactInsert,
  DbMemoryProcedure,
  DbMemoryProcedureInsert,
  DbOrchestrationEvent,
  DbOrchestrationEventInsert,
  DbScheduledRun,
  DbScheduledRunInsert,
  DbSession,
  DbSessionInsert,
  DbToolCallApproval,
  DbToolCallApprovalInsert,
  DbToolCallAudit,
  DbToolCallAuditInsert,
  DbToolRegistry,
  DbToolRegistryInsert,
  DbWorkspace,
  DbWorkspaceInsert,
} from './schema'

// ── Durable board — repository + state machine + contention ──
export * from './board'

// ── Unified capability inventory — durable projection + data-access ──
export * from './capabilities'

// ── MCP trifecta — memory store + tools broker ─────────────────
export * from './memory'
export * from './tools'

// ── Governance — budget kill-switch + forensic audit ────
export * from './governance'

// ── Observability — append-only orchestration event log ────────
export * from './events'

// ── Sessions — rotation lineage writer (session-rotation) ──────
export * from './sessions'

// ── Routines — durable scheduled-runs ledger (the external wake) ──
export * from './routines'

// ── team_chat — the mixed-runtime peer-chat room substrate ─────
export * from './teamChat'

// ── chat_messages — the durable transcript tail (live team-chat SSE) ──
export * from './chat'

// ── Database connection + helpers ──────────────────────────────────────────
export {
  createDb,
  defaultDbPath,
  getSetting,
  setSetting,
  integrityCheck,
  listTableNames,
} from './db'
export type { ClawbooDb } from './db'
