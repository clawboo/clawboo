// Durable board — data-access layer.
// Re-exported through the package barrel (src/index.ts) so tsup ships it.
//
// The transition rules are NOT declared here: they live in the pure, zero-dep
// @clawboo/board-core so the browser UI and the orchestration engine can read the
// same table without pulling the sqlite/server graph. Re-exported unchanged, so
// `@clawboo/db`'s public surface is unaffected by the move.
//
// Named rather than `export *`: tsup keeps a workspace dependency external, and a
// star re-export of an external module leaves downstream bundlers unable to resolve
// the names statically (esbuild fails the apps/web server build). Local modules
// below are safe to star-export — they are bundled, not external.
export {
  RUN_COST_SOURCES,
  TASK_STATUSES,
  answerForAgent,
  answerWords,
  askedWords,
  canTransition,
  clampAgentTaskPriority,
  delegatorOf,
  findHandOffCycle,
  formatInterSessionMessage,
  formatPeerPost,
  isLocked,
  isTaskStatus,
  isTaskIdentifier,
  isPlanHolder,
  isTerminal,
  legalTargets,
  LOCAL_PERSON,
  normalizeAnswer,
  oneLine,
  parseQuestionPayload,
  parseWaitingOn,
  planStepsMatch,
  renderPlanBody,
  summarizeRunCost,
  TASK_DOCUMENT_MAX_CHARS,
  TASK_DOCUMENT_MAX_REVISIONS,
  TASK_DOCUMENT_PLAN_KEY,
  waitingOnJson,
  waitsOnOtherWork,
} from '@clawboo/board-core'
export type {
  PlanRef,
  HandOffLink,
  AttentionReason,
  InterSessionAttribution,
  PeerPostLike,
  QuestionAnswer,
  QuestionKind,
  QuestionPayload,
  RunCostSource,
  SuggestedTask,
  TaskAttention,
  TaskRunCost,
  TaskStatus,
  WaitingOn,
} from '@clawboo/board-core'
export * from './agentWakes'
export * from './jobRuns'
export * from './jobStop'
export * from './attention'
export * from './attempts'
export { deriveCreateKey } from './createDedupe'
export * from './delegationFailures'
export * from './identifiers'
export * from './labels'
export * from './events'
export * from './pauses'
export * from './plans'
export * from './questionExpiry'
export * from './questions'
export * from './readState'
export * from './repository'
export * from './resultClaim'
export * from './rooms'
export * from './runCost'
export * from './runnerInputs'
export * from './runningSince'
export * from './contention'
export * from './schemas'
export * from './verification'
