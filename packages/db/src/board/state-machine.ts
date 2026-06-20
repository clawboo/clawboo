// ─── Task state machine ─────────────────────────────────────────────────────
// Pure transition rules for the 7 task statuses. Enforced INSIDE the write
// transaction against the freshly-read row (so two concurrent updates can't both
// pass a stale pre-check); any REST-layer pre-check is just fast-fail ergonomics.

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
