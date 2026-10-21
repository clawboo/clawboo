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
  canTransition,
  isLocked,
  isTaskStatus,
  isTerminal,
  legalTargets,
  summarizeRunCost,
} from '@clawboo/board-core'
export type {
  AttentionReason,
  RunCostSource,
  TaskAttention,
  TaskRunCost,
  TaskStatus,
} from '@clawboo/board-core'
export * from './attention'
export * from './attempts'
export * from './events'
export * from './repository'
export * from './runCost'
export * from './runningSince'
export * from './contention'
export * from './schemas'
export * from './verification'
