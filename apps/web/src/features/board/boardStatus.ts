// Canonical board-status metadata for the web UI: the ordered status list, the
// human labels the board renders, and the legal-transition table the manual
// status editor offers.
//
// This is a deliberate BROWSER-SIDE MIRROR of the server state machine in
// packages/db/src/board/state-machine.ts. The server remains the source of truth
// (it re-checks every transition inside the write transaction and 409s an illegal
// one), so this table is purely for ergonomics — it lets the UI offer only the
// moves the server will accept instead of surfacing options that always fail.
// Importing @clawboo/db here would drag the sqlite/server graph into the browser
// bundle, so we mirror the 7 statuses locally (as BoardPanel already did for its
// columns). KEEP THIS IN SYNC with state-machine.ts if the transitions change.

/** The 7 task statuses, in lifecycle order (matches the board's column order). */
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Human labels for each status — the single source the columns and the status
 *  editor both read, so a rename happens in one place. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}

// Legal forward transitions, mirroring state-machine.ts. `done` / `cancelled` are
// terminal. Same-status is always an allowed no-op (handled by the helpers below).
const LEGAL_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['todo', 'blocked', 'cancelled'],
  todo: ['in_progress', 'blocked', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'done', 'blocked', 'todo', 'cancelled'],
  in_review: ['done', 'in_progress', 'blocked', 'cancelled'],
  blocked: ['todo', 'in_progress', 'backlog', 'cancelled'],
  done: [],
  cancelled: [],
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/** Terminal statuses have no outgoing transitions — the editor locks on them. */
export function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'cancelled'
}

/** A human label for any status string (off-list statuses fall back to raw). */
export function statusLabel(status: string): string {
  return isTaskStatus(status) ? STATUS_LABEL[status] : status
}

/**
 * The statuses the manual editor should offer for a task currently in `from`:
 * the current status (so it renders as the selected value) plus every legal
 * target, in canonical order. An unknown/off-list current status yields just
 * itself, so the editor degrades to a locked, read-only display rather than
 * offering moves the server would reject.
 */
export function statusOptions(from: string): TaskStatus[] {
  if (!isTaskStatus(from)) return []
  const reachable = new Set<TaskStatus>([from, ...LEGAL_TRANSITIONS[from]])
  return TASK_STATUSES.filter((s) => reachable.has(s))
}
