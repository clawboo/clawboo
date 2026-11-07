// ── Schema — tables + indexes + inferred types ─────────────────────────────
export {
  agents,
  approvalHistory,
  approvalRules,
  booZeroTeamBriefs,
  budgetReservations,
  budgets,
  capabilities,
  capabilityGrants,
  chatMessages,
  connectors,
  costRecords,
  executionProcesses,
  governanceAudit,
  graphLayouts,
  memoryFacts,
  memoryOutcomes,
  memoryProcedures,
  orchestrationEvents,
  roomMembers,
  rooms,
  scheduledRuns,
  sessions,
  settings,
  skills,
  taskComments,
  taskDeps,
  taskQuestions,
  tasks,
  agentWakeChains,
  agentWakeGates,
  taskWakes,
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
  DbApprovalRule,
  DbApprovalRuleInsert,
  DbBooZeroTeamBrief,
  DbBooZeroTeamBriefInsert,
  DbBudget,
  DbBudgetInsert,
  DbBudgetReservation,
  DbCapability,
  DbCapabilityInsert,
  DbCapabilityGrant,
  DbCapabilityGrantInsert,
  DbChatMessage,
  DbChatMessageInsert,
  DbConnector,
  DbConnectorInsert,
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
  DbAgentWakeChain,
  DbAgentWakeGate,
  DbTaskWake,
  DbTaskCommentInsert,
  DbTaskDep,
  DbTaskDepInsert,
  DbTaskInsert,
  DbTaskQuestion,
  DbTeam,
  DbTeamInsert,
  DbTeamChat,
  DbTeamChatInsert,
  DbTeamProfile,
  DbTeamProfileInsert,
  DbMemoryFact,
  DbMemoryFactInsert,
  DbMemoryOutcome,
  DbMemoryOutcomeInsert,
  DbMemoryProcedure,
  DbMemoryProcedureInsert,
  DbOrchestrationEvent,
  DbOrchestrationEventInsert,
  DbRoom,
  DbRoomInsert,
  DbRoomMember,
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
// ── Durable agent mailbox (the delivery plane) ──
export * from './inbox'
// ── Durable [Task Update] outbox (team chat report-ups) ──
export * from './reportUps'
export * from './taskWakes'

// ── chat_messages — the durable transcript tail (live team-chat SSE) ──
export * from './chat'

// ── A person a sign-in proxy vouched for, as rows record them ──
export { parsePersonJson, personJson } from './person'
export type { PersonRecord } from './person'
export type { EventActor } from '@clawboo/obs'

// ── The grant spine: capability_grants IS the Ghost Graph edge ──
export * from './grants'

// ── Database connection + helpers ──────────────────────────────────────────
export {
  createDb,
  openDb,
  defaultDbPath,
  getSetting,
  setSetting,
  integrityCheck,
  listTableNames,
} from './db'
export type { ClawbooDb } from './db'
export { ensureSchema, missingSchemaColumns } from './schemaBootstrap'
export { SchemaUpgradeError } from './schemaReconcile'
export type { AddedColumn, SchemaReconcileReport } from './schemaReconcile'
export { dbOpenStats } from './openStats'
