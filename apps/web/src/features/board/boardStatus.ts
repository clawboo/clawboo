// Board-status metadata for the web UI: the human labels the board renders, plus
// the string-tolerant helpers the columns and the manual status editor consume.
//
// The status list and the legal-transition table are NOT declared here. They come
// from @clawboo/board-core — the same pure, zero-dep rulebook @clawboo/db enforces
// inside its write transaction — so the UI can only ever offer moves the server
// will accept, and a server-side change to the machine cannot silently drift the
// board. board-core has no imports at all, so nothing of the sqlite/server graph
// reaches the browser bundle (guarded by src/__tests__/browserBundlePurity.test.ts).
//
// The server remains the authority: it re-checks every transition inside the write
// and 409s an illegal one. This module is ergonomics — it stops the UI from
// surfacing options that would always fail.
//
// DX note: the SPA reads these tables from packages/board-core/dist, so editing the
// state machine mid-`pnpm dev` needs a package rebuild to reach the browser (true of
// every @clawboo/* package the SPA consumes; `turbo dev` covers first start).

import {
  TASK_STATUSES,
  canTransition as canTransitionStrict,
  isTaskStatus,
  isTerminal,
  legalTargets,
  type TaskStatus,
} from '@clawboo/board-core'

export { TASK_STATUSES, isTaskStatus }
export type { TaskStatus }

/** Human labels for each status — the single source the columns and the status
 *  editor both read, so a rename happens in one place. Typed against the shared
 *  union, so a new server status is a typecheck failure here, not a silent gap. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}

/**
 * Whether the server would accept a `from → to` status change. Same-status is an
 * idempotent no-op (allowed), matching the server's `canTransition`. Off-list
 * statuses have no legal moves — the guard runs BEFORE the same-status check, so
 * an unknown status is never reported as movable, not even onto itself. Used by
 * the drag-and-drop handler to reject an illegal move client-side (no wasted
 * PATCH), exactly as the drawer's status editor only offers legal targets.
 *
 * Takes plain strings because a task's status arrives from the API untyped.
 */
export function canTransition(from: string, to: string): boolean {
  if (!isTaskStatus(from) || !isTaskStatus(to)) return false
  return canTransitionStrict(from, to)
}

/** Terminal statuses have no outgoing transitions — the editor locks on them. */
export function isTerminalStatus(status: string): boolean {
  return isTaskStatus(status) && isTerminal(status)
}

/** A human label for any status string (off-list statuses fall back to raw). */
export function statusLabel(status: string): string {
  return isTaskStatus(status) ? STATUS_LABEL[status] : status
}

/**
 * The statuses the manual editor should offer for a task currently in `from`:
 * the current status (so it renders as the selected value) plus every legal
 * target, in canonical lifecycle order — NOT transition-table order, because the
 * dropdown reads as the board's column order. An unknown/off-list current status
 * yields an EMPTY list, which is what makes the editor degrade to a locked,
 * read-only display rather than offering moves the server would reject.
 */
export function statusOptions(from: string): TaskStatus[] {
  if (!isTaskStatus(from)) return []
  const reachable = new Set<TaskStatus>([from, ...legalTargets(from)])
  return TASK_STATUSES.filter((s) => reachable.has(s))
}
