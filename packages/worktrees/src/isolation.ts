// Isolation-level policy. The spectrum runs shared-cwd → worktree → container →
// VM; this module decides the *default execution-isolation* tier for a task by
// kind. Worktrees give concurrency isolation only (no write races) — NOT a
// privilege boundary. Anything that runs untrusted code, runs Docker itself, or
// crosses a tenant boundary must escalate to `container` (or a microVM), which a
// runtime/governance layer provisions — this package never runs Docker.

import type { IsolationLevel, TaskKind } from './types'

/**
 * Decide the isolation level for a task by kind.
 *
 * - Read-only / research work → `none`: it mutates no files, so paying the
 *   worktree cost (a checkout + per-worktree dep install) buys nothing.
 * - File-mutating work → `worktree`: its own checkout + branch so parallel
 *   teammates can't trample each other ("collisions are impossible, not merely
 *   discouraged").
 * - `review` is read-only by design but runs in a *detached* worktree at a
 *   specific commit (see `provisionReviewWorktree`) so a reviewer literally has
 *   no branch to push — hence `none` here (no writable worktree is provisioned
 *   for it through the normal path).
 *
 * `container` is never returned automatically in v0.x; it is an explicit opt-in
 * tier (keyed off a repo `devcontainer.json`) recorded here as the documented
 * escalation point for untrusted / Docker-running / cross-tenant work.
 */
export function isolationForTask(kind: TaskKind): IsolationLevel {
  switch (kind) {
    case 'research':
    case 'review':
      return 'none'
    case 'code':
      return 'worktree'
    default:
      // Unknown kinds default to the safe-for-concurrency choice: isolate
      // file mutation. A caller that knows the work is read-only passes
      // 'research' to opt out.
      return 'worktree'
  }
}

/** Whether a task kind needs a provisioned (writable) worktree. */
export function needsWorktree(kind: TaskKind): boolean {
  return isolationForTask(kind) === 'worktree'
}
