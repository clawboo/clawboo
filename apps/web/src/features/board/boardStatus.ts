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
  LOCAL_PERSON_ID,
  TASK_STATUSES,
  canTransition as canTransitionStrict,
  isTaskStatus,
  isTerminal,
  legalTargets,
  parseWaitingOn,
  waitsOnOtherWork,
  type AccountFailure,
  type AgentWakeCard,
  type AttentionReason,
  type TaskAttention,
  type TaskStatus,
} from '@clawboo/board-core'

import type { StatusTone } from '@/features/shared/StatusPill'

export { TASK_STATUSES, isTaskStatus }
export type { AccountFailure, AttentionReason, TaskAttention, TaskStatus }

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

/** Statuses only an agent's run puts a task in. */
const RUN_STATUSES = new Set<string>(['in_progress', 'in_review'])

/**
 * The statuses a PERSON may pick in the status editor. `in_progress` and
 * `in_review` are left out unless the task is already there: a task is in
 * progress because an agent is running it, and in review because its work is
 * being verified. Choosing either by hand starts no run and no check, so the
 * card would look worked on while nothing works on it.
 */
export function manualStatusOptions(
  from: string,
  ctx: { personAssigned?: boolean } = {},
): TaskStatus[] {
  const options = statusOptions(from).filter((s) => !RUN_STATUSES.has(s) || s === from)
  // A person's own task: nothing else will move it to Done, so they can from anywhere.
  if (ctx.personAssigned && isTaskStatus(from) && !isTerminal(from) && !options.includes('done'))
    return TASK_STATUSES.filter((s) => s === 'done' || options.includes(s))
  return options
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
  'unstarted',
  'question',
  'assigned',
  'agent_wakes',
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
  unstarted: {
    label: 'Not started',
    tone: 'warning',
    hint: 'It is marked In progress, but no agent has it and nothing is running. Retry it or give it to an agent.',
  },
  question: {
    label: 'Waiting for your answer',
    tone: 'warning',
    hint: 'An agent asked you something and stopped. Your answer starts it again.',
  },
  assigned: {
    label: 'Assigned to you',
    tone: 'warning',
    hint: 'This one is yours. Mark it done when it is finished, or give it to an agent.',
  },
  agent_wakes: {
    label: 'Waiting for your OK',
    tone: 'warning',
    hint: 'An agent wants to start a teammate on this job. Say whether agents may wake each other.',
  },
}

/** A run the provider refused for the account: the badge in place of "Failed",
 *  and what to do, for a run that left no text of its own. The fix is the same
 *  for both, in Settings at the runtime. */
export const ACCOUNT_FAILURE_META: Record<AccountFailure, { label: string; hint: string }> = {
  sign_in: {
    label: 'Sign-in failed',
    hint: "The runtime's key or login was refused. Fix the sign-in, then retry.",
  },
  billing: {
    label: 'Billing problem',
    hint: 'The provider refused the account (billing or credit). Fix it, then retry.',
  },
}

/** The action a card offers for an account failure, in place of Retry. */
export const FIX_SIGN_IN = 'Fix sign-in'

/** The badge for a needs-you task: "Failed", or "Failed 3×" once it has failed
 *  more than once in a row. An account failure names its cause instead. `assignee`
 *  is who has a person's task, when that is not you. */
export function attentionLabel(attention: TaskAttention, assignee?: string | null): string {
  if (attention.reason === 'assigned' && assignee) return `Assigned to ${assignee}`
  const base = attention.cause
    ? ACCOUNT_FAILURE_META[attention.cause].label
    : ATTENTION_META[attention.reason].label
  const repeated =
    (attention.reason === 'failed' || attention.reason === 'timed_out') && attention.failedRuns > 1
  return repeated ? `${base} ${attention.failedRuns}×` : base
}

/** The card about agents waking each other, off a task's attention. */
function readAgentWakeCard(value: unknown): AgentWakeCard | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v['jobTaskId'] !== 'string') return null
  const kind = v['kind']
  if (kind !== 'ask' && kind !== 'hourly_cap' && kind !== 'back_and_forth') return null
  const id = (x: unknown): string | null => (typeof x === 'string' ? x : null)
  return {
    jobTaskId: v['jobTaskId'],
    kind,
    fromAgentId: id(v['fromAgentId']),
    toAgentId: id(v['toAgentId']),
    ...(typeof v['alsoWaiting'] === 'number' ? { alsoWaiting: v['alsoWaiting'] } : {}),
  }
}

/**
 * A task's needs-you state as the board should render it. Reads the server's
 * `attention` field; a `blocked` task always needs a person, so one that arrives
 * without the field (an older server, a live frame that raced the ledger) is
 * still routed as blocked rather than left looking like queued work. One waiting on
 * another task or on its own sub-tasks is the exception: the board moves it on.
 */
export function taskAttentionOf(task: {
  status: string
  attention?: unknown
  waitingOn?: unknown
}): TaskAttention | null {
  const a = task.attention
  if (a && typeof a === 'object') {
    const {
      reason,
      failedRuns,
      detail,
      cause,
      runtime,
      byPerson,
      questionId,
      personId,
      handedBack,
      agentWakes,
    } = a as {
      reason?: unknown
      failedRuns?: unknown
      detail?: unknown
      cause?: unknown
      runtime?: unknown
      byPerson?: unknown
      questionId?: unknown
      personId?: unknown
      handedBack?: unknown
      agentWakes?: unknown
    }
    if (typeof reason === 'string' && ATTENTION_REASONS.has(reason)) {
      const known = cause === 'sign_in' || cause === 'billing' ? cause : null
      const card = readAgentWakeCard(agentWakes)
      return {
        reason: reason as AttentionReason,
        failedRuns: typeof failedRuns === 'number' ? failedRuns : 0,
        ...(typeof detail === 'string' && detail ? { detail } : {}),
        ...(known
          ? { cause: known, ...(typeof runtime === 'string' && runtime ? { runtime } : {}) }
          : {}),
        ...(byPerson === true ? { byPerson: true } : {}),
        ...(typeof questionId === 'string' ? { questionId } : {}),
        ...(typeof personId === 'string' ? { personId } : {}),
        ...(handedBack === true ? { handedBack: true } : {}),
        ...(card ? { agentWakes: card } : {}),
      }
    }
  }
  // An explicit null is the server's verdict that it does not need a person, which a
  // task waiting on other work gets. A chat card's frame carries no `waitingOn`.
  if (a === null) return null
  if (task.status === 'blocked' && !waitsOnOtherWork(parseWaitingOn(task.waitingOn)))
    return { reason: 'blocked', failedRuns: 0 }
  return null
}

// ─── People ─────────────────────────────────────────────────────────────────

/** Why a person's words did not reach an agent (a `not-delivered` reply). */
export function notDeliveredWhy(reason: string): string {
  switch (reason) {
    case 'finished':
      return 'the task is finished'
    case 'unassigned':
      return 'no agent has this task'
    case 'room_archived':
      return 'this task’s chat room was archived. Restart Clawboo to move it to General.'
    case 'no_team':
      return 'this task’s team was deleted'
    default:
      return 'something went wrong'
  }
}

/** The question a board row says is open (`openQuestion`), or null. */
export function openQuestionOf(task: {
  status?: unknown
  openQuestion?: unknown
}): { id: string; kind: string; payload: unknown } | null {
  const q = task.openQuestion as { id?: unknown; kind?: unknown; payload?: unknown } | null
  if (!q || typeof q.id !== 'string' || typeof q.kind !== 'string') return null
  return { id: q.id, kind: q.kind, payload: q.payload }
}

/** The person a task is assigned to, as the row stores it, or null. */
export function assigneePersonOf(task: {
  status?: unknown
  assigneePersonId?: unknown
  assigneePerson?: unknown
}): { id: string; name: string | null } | null {
  if (typeof task.assigneePersonId !== 'string' || !task.assigneePersonId) return null
  let name: string | null = null
  try {
    const doc: unknown =
      typeof task.assigneePerson === 'string'
        ? JSON.parse(task.assigneePerson)
        : task.assigneePerson
    const raw = (doc as { name?: unknown } | null)?.name
    if (typeof raw === 'string' && raw) name = raw
  } catch {
    // The id still says whose it is.
  }
  return { id: task.assigneePersonId, name }
}

/** Is this task the viewer's? Their own id, or the install's built-in person, which
 *  stands for whoever is at the dashboard. */
export function isMyTask(
  task: { status?: unknown; assigneePersonId?: unknown },
  me: { id: string } | null | undefined,
): boolean {
  const id = task.assigneePersonId
  if (typeof id !== 'string' || !id) return false
  return id === LOCAL_PERSON_ID || id === me?.id
}

/** Who has a person's task, for a badge: null when it is the viewer's, whose badge
 *  already says "you". */
export function otherAssigneeName(
  task: { status?: unknown; assigneePersonId?: unknown; assigneePerson?: unknown },
  me: { id: string } | null | undefined,
): string | null {
  if (isMyTask(task, me)) return null
  const person = assigneePersonOf(task)
  return person ? (person.name ?? 'a person') : null
}

/**
 * What a card says for a task waiting on other work, or null when it is not. The
 * server attaches `waitingOnDetail` to a row: the title of the task it waits on, or
 * how many of its sub-tasks are open.
 */
export function waitingWorkLabel(task: {
  status: string
  waitingOn?: unknown
  waitingOnDetail?: unknown
}): string | null {
  if (task.status !== 'blocked') return null
  const w = parseWaitingOn(task.waitingOn)
  if (!w || !waitsOnOtherWork(w)) return null
  const detail = (task.waitingOnDetail ?? {}) as { taskTitle?: unknown; openSubtasks?: unknown }
  if (w.kind === 'task') {
    return typeof detail.taskTitle === 'string' && detail.taskTitle
      ? `Waiting on “${detail.taskTitle}”`
      : 'Waiting on another task'
  }
  const n = typeof detail.openSubtasks === 'number' ? detail.openSubtasks : 0
  if (n <= 0) return 'Waiting on its sub-tasks'
  return `Waiting on ${n} sub-${n === 1 ? 'task' : 'tasks'}`
}

// ─── Board columns ──────────────────────────────────────────────────────────

/** The needs-you column's id. Not a status: its cards come from several. */
export const NEEDS_YOU_COLUMN = 'needs_you'

/**
 * The status columns, after Needs you. `in_review` has no column of its own: it
 * is the automated verification step, so those cards sit in In progress under a
 * "Verifying" badge, and a verdict that needs a person sends the task to Needs
 * you. `blocked` has none either: a blocked task needs a person, unless it waits on
 * other work, and then it sits in In progress, saying what it waits on.
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
export function boardColumnOf(task: {
  status: string
  attention?: unknown
  waitingOn?: unknown
}): string {
  if (taskAttentionOf(task)) return NEEDS_YOU_COLUMN
  if (task.status === 'in_review' || task.status === 'blocked') return 'in_progress'
  return task.status
}
