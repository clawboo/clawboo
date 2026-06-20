// @clawboo/worktrees — per-task git-worktree lifecycle + runtime-agnostic
// system-of-record scaffold + structured cross-runtime handoff.
//
// Server-only (shells out to `git`, writes files). The board is the dispatcher;
// the task's worktree is the durable world any runtime — agent or human — can
// pick up cold from `TASK.md` / `task-progress.md` / `AGENT_HANDOFF.json`.

export type {
  IsolationLevel,
  TaskKind,
  Worktree,
  DiffStat,
  TaskScaffoldInput,
  ResumeState,
} from './types'

export { isolationForTask, needsWorktree } from './isolation'

export {
  SOR_FILES,
  renderTaskMd,
  renderProgressMd,
  renderDecisionsJson,
  renderInitSh,
  renderVerificationMd,
  writeScaffold,
} from './scaffold'

export {
  agentHandoffSchema,
  writeHandoff,
  readHandoff,
  reconstructState,
  type AgentHandoff,
  type AgentHandoffInput,
} from './handoff'

export {
  provisionWorktree,
  resumeWorktree,
  loadWorktree,
  pauseWorktree,
  commitWorktreeWork,
  completeWorktree,
  gcWorktrees,
  provisionReviewWorktree,
  removeReviewWorktree,
  type ProvisionOptions,
  type ResumeOptions,
  type LoadOptions,
  type PauseResult,
  type CommitResult,
  type CompleteResult,
  type GcOptions,
  type GcResult,
  type ReviewOptions,
} from './lifecycle'

// Low-level git helpers — exported for the server orchestrator + tests
// (resolve a base SHA, inspect a diff, detect a detached reviewer HEAD).
export {
  GitError,
  isGitRepo,
  resolveBaseSha,
  revParse,
  branchExists,
  branchNameForTask,
  worktreeRootFor,
  diffStat,
  worktreeDiff,
  isDetached,
  isWorktreeRegistered,
  KeyedMutex,
} from './git'
