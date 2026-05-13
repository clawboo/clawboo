// ── Schema — tables + indexes + inferred types ─────────────────────────────
export {
  agents,
  approvalHistory,
  booZeroTeamBriefs,
  chatMessages,
  costRecords,
  graphLayouts,
  settings,
  skills,
  teams,
  teamProfiles,
} from './schema'

export type {
  DbAgent,
  DbAgentInsert,
  DbApprovalHistory,
  DbApprovalHistoryInsert,
  DbBooZeroTeamBrief,
  DbBooZeroTeamBriefInsert,
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
  DbTeam,
  DbTeamInsert,
  DbTeamProfile,
  DbTeamProfileInsert,
} from './schema'

// ── Database connection + helpers ──────────────────────────────────────────
export { createDb, getSetting, setSetting } from './db'
export type { ClawbooDb } from './db'
