// Shared types for the per-task worktree lifecycle + system-of-record.

/**
 * The execution-isolation level for a task's work. Orthogonal to the security
 * sandbox (which the runtime owns): a worktree gives *concurrency* isolation
 * (no write races between parallel teammates), NOT a privilege boundary.
 *
 * - `none`      — read-only / research work runs in place; no worktree cost.
 * - `worktree`  — file-mutating work gets its own git worktree + branch (default).
 * - `container` — reserved opt-in tier for untrusted / Docker-running / parallel
 *                 writers, keyed off a repo `devcontainer.json`. Not provisioned
 *                 by this package; documented as the seam where a real privilege
 *                 boundary (container / microVM) becomes mandatory.
 */
export type IsolationLevel = 'none' | 'worktree' | 'container'

/** What a task does — drives the isolation decision. Open set. */
export type TaskKind = 'code' | 'research' | 'review' | (string & {})

/** A provisioned worktree: a process-agnostic, on-disk world for one task. */
export interface Worktree {
  /** The board task this worktree belongs to (empty for a detached reviewer). */
  taskId: string
  /** Absolute path to the worktree checkout. */
  worktreePath: string
  /** Branch name (`clawboo/task-<id>`); empty string for a detached reviewer. */
  branch: string
  /**
   * The commit the agent's work is measured against — the baseline commit that
   * captures the SoR scaffold (the branch-point SHA is its parent in git
   * history). `completeWorktree` diffs against this to decide clean-vs-retain.
   */
  baseCommit: string
  /** Read-only reviewer worktree (detached HEAD; no branch to push). */
  detached: boolean
}

/** Summary of changes in a worktree relative to its baseline commit. */
export interface DiffStat {
  filesChanged: number
  insertions: number
  deletions: number
  /** Any change at all (committed delta vs baseline OR uncommitted OR untracked). */
  dirty: boolean
}

/** Inputs for rendering a task's system-of-record scaffold. */
export interface TaskScaffoldInput {
  taskId: string
  title: string
  description?: string | null
  /** Acceptance criteria — what "done" means for this task. */
  acceptanceCriteria?: string[]
  /** Known gotchas / constraints the agent should not rediscover. */
  knownGotchas?: string[]
  /** Runtime-agnostic startup commands baked into `init.sh`. */
  commands?: { install?: string; verify?: string; start?: string }
  /** Optional team context (for the TASK.md header). */
  teamName?: string | null
}

/**
 * The reconstructed state a fresh runtime derives at clock-in — read purely
 * from the worktree's system-of-record (`AGENT_HANDOFF.json` + `task-progress.md`
 * + `init.sh`), with NO access to chat history or the board UI. This is the
 * proof that the SoR is runtime-agnostic: shell + git + JSON, nothing else.
 */
export interface ResumeState {
  /** True when an `AGENT_HANDOFF.json` was present and validated. */
  hasHandoff: boolean
  /** Completed subtasks (what works now). */
  done: string[]
  /** Broken / unverified items (what to be careful of). */
  broken: string[]
  /** The single next best step, if recorded. */
  next: string | null
  /** Why the task is blocked, if it is. */
  whyBlocked?: string | null
  /** Startup / verify / start commands (from the handoff, falling back to init.sh). */
  commands: { init: string; verify: string; start: string }
  /** Free-form warnings the previous runtime left behind. */
  warnings: string[]
  /** Which runtime wrote the last handoff (role-neutral; may be `human`). */
  lastRuntime?: string | null
  /** Native session id of the runtime that wrote the handoff — the same-runtime
   *  resume handle (e.g. a Hermes/Claude session id). Consumed only when
   *  `lastRuntime` matches the next dispatch's runtime. */
  nativeSessionId?: string | null
}
