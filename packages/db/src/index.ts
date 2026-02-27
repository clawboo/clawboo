// ── Schema — tables + indexes + inferred types ─────────────────────────────
export {
  agents,
  approvalHistory,
  chatMessages,
  costRecords,
  graphLayouts,
  settings,
  skills,
  teamProfiles,
} from './schema'

export type {
  DbAgent,
  DbAgentInsert,
  DbApprovalHistory,
  DbApprovalHistoryInsert,
  DbChatMessage,
  DbChatMessageInsert,
  DbCostRecord,
  DbCostRecordInsert,
  DbGraphLayout,
  DbGraphLayoutInsert,
  DbSetting,
  DbSettingInsert,
  DbSkill,
  DbSkillInsert,
  DbTeamProfile,
  DbTeamProfileInsert,
} from './schema'

// ── Database connection + helpers ──────────────────────────────────────────
export { createDb, getSetting, setSetting } from './db'
export type { ClawbooDb } from './db'
