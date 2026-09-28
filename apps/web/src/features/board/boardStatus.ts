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
  type AttentionReason,
  type TaskAttention,
  type TaskStatus,
} from '@clawboo/board-core'

import type { StatusTone } from '@/features/shared/StatusPill'

export { TASK_STATUSES, isTaskStatus }
export type { AttentionReason, TaskAttention, TaskStatus }

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

/**
 * The statuses a PERSON may pick in the status editor. `in_review` is left out
 * unless the task is already there: it is the automated verification step (the
 * builder's work being checked), and choosing it by hand would park a card under
 * a "Verifying" badge with nothing verifying it.
 */
export function manualStatusOptions(from: string): TaskStatus[] {
  return statusOptions(from).filter((s) => s !== 'in_review' || s === from)
}

// ─── Needs you ──────────────────────────────────────────────────────────────
// A task needs you when nothing on the board will move it forward by itself
// (the server computes why with @clawboo/board-core's `taskAttention`). Those
// tasks live in the board's first column beside pending approvals, instead of
// sitting in To do or a Blocked column looking like work in progress.

const ATTENTION_REASONS = new Set<string>([
  'failed',
  'timed_out',
  'stopped',
  'needs_review',
  'blocked',
  'unassigned',
])

/** How each reason reads on a card: a short badge and one line of guidance. */
export const ATTENTION_META: Record<
  AttentionReason,
  { label: string; tone: StatusTone; hint: string }
> = {
  failed: {
    label: 'Failed',
    tone: 'error',
    hint: 'The run failed. Retry it, give it to someone else, or dismiss it.',
  },
  timed_out: {
    label: 'Timed out',
    tone: 'error',
    hint: 'The agent stopped responding and the run was ended.',
  },
  stopped: {
    label: 'Stopped',
    tone: 'warning',
    hint: 'You stopped this run. It will not restart on its own.',
  },
  needs_review: {
    label: 'Needs review',
    tone: 'warning',
    hint: 'Verification could not pass this. Review the result, then retry or complete it.',
  },
  blocked: {
    label: 'Blocked',
    tone: 'warning',
    hint: 'Marked blocked. Decide how to unblock it.',
  },
  unassigned: {
    label: 'Unassigned',
    tone: 'warning',
    hint: 'No agent will pick this up until you assign one.',
  },
}

/** The badge for a needs-you task: "Failed", or "Failed 3×" once it has failed
 *  more than once in a row. */
export function attentionLabel(attention: TaskAttention): string {
  const base = ATTENTION_META[attention.reason].label
  const repeated =
    (attention.reason === 'failed' || attention.reason === 'timed_out') && attention.failedRuns > 1
  return repeated ? `${base} ${attention.failedRuns}×` : base
}

/**
 * A task's needs-you state as the board should render it. Reads the server's
 * `attention` field; a `blocked` task always needs a person, so one that arrives
 * without the field (an older server, a live frame that raced the ledger) is
 * still routed as blocked rather than left looking like queued work.
 */
export function taskAttentionOf(task: {
  status: string
  attention?: unknown
}): TaskAttention | null {
  const a = task.attention
  if (a && typeof a === 'object') {
    const { reason, failedRuns, detail } = a as {
      reason?: unknown
      failedRuns?: unknown
      detail?: unknown
    }
    if (typeof reason === 'string' && ATTENTION_REASONS.has(reason)) {
      return {
        reason: reason as AttentionReason,
        failedRuns: typeof failedRuns === 'number' ? failedRuns : 0,
        ...(typeof detail === 'string' && detail ? { detail } : {}),
      }
    }
  }
  if (task.status === 'blocked') return { reason: 'blocked', failedRuns: 0 }
  return null
}

// ─── Board columns ──────────────────────────────────────────────────────────

/** The needs-you column's id. Not a status: its cards come from several. */
export const NEEDS_YOU_COLUMN = 'needs_you'

/**
 * The status columns, after Needs you. `in_review` has no column of its own: it
 * is the automated verification step, so those cards sit in In progress under a
 * "Verifying" badge, and a verdict that needs a person sends the task to Needs
 * you. `blocked` has none either: every blocked task needs a person.
 */
export const BOARD_STATUS_COLUMNS: readonly TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'done',
  'cancelled',
]

/** Which column a task sits in: Needs you, one of the status columns, or its raw
 *  status when that is off-list (the board parks those in "Other"). */
export function boardColumnOf(task: { status: string; attention?: unknown }): string {
  if (taskAttentionOf(task)) return NEEDS_YOU_COLUMN
  if (task.status === 'in_review') return 'in_progress'
  return task.status
}
