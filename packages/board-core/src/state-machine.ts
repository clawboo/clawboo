// ─── Task state machine ─────────────────────────────────────────────────────
// Pure transition rules for the 7 task statuses — the SINGLE source of truth,
// shared by every layer that needs them:
//   · @clawboo/db re-exports it and enforces it INSIDE the write transaction
//     against the freshly-read row (so two concurrent updates can't both pass a
//     stale pre-check); any REST-layer pre-check is just fast-fail ergonomics.
//   · @clawboo/team-orchestration types its BoardClient surface with it.
//   · The board UI (apps/web) derives its columns and its manual status editor
//     from it, so it only ever offers moves the server will accept.
//
// This module MUST stay import-free. That purity is what lets it ship into the
// Vite SPA without dragging the sqlite/server graph along, and it is asserted by
// the source guard in __tests__/state-machine.test.ts.

export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
]

// Legal forward transitions. `done` / `cancelled` are terminal (no outgoing).
// `in_progress → todo` is the "release" path used by orphan reconciliation.
const LEGAL: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['todo', 'blocked', 'cancelled'],
  todo: ['in_progress', 'blocked', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'done', 'blocked', 'todo', 'cancelled'],
  in_review: ['done', 'in_progress', 'blocked', 'cancelled'],
  blocked: ['todo', 'in_progress', 'backlog', 'cancelled'],
  done: [],
  cancelled: [],
}

/** Same-status is an idempotent no-op (allowed). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  return LEGAL[from]?.includes(to) ?? false
}

/**
 * Every status `from` can legally move to, in table order. Excludes the
 * same-status no-op that `canTransition` allows, and is empty for a terminal
 * status. Returns a fresh array so a caller can't mutate the internal table.
 *
 * This is what lets a UI enumerate "which moves are legal from here" instead of
 * hand-copying the table — see apps/web/src/features/board/boardStatus.ts.
 */
export function legalTargets(from: TaskStatus): TaskStatus[] {
  return [...(LEGAL[from] ?? [])]
}

/** Locked = actively owned; assignee must not be reassigned while locked. */
export function isLocked(status: TaskStatus): boolean {
  return status === 'in_progress' || status === 'in_review'
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled'
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}
