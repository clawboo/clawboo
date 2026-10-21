// The rules for a person finishing a task by hand (moving it to Done or
// Cancelled), shared by the board's drag and the task drawer. Pure, so the
// cases are tested without a DOM.
//
// Finished work sits on the day it finished. A card that sits on another day
// would jump to today if the board guessed, so the person picks the day instead:
// today, the day it sits on, or another day in between. Cancelling always asks,
// because it cannot be undone; so does finishing a card an agent is still
// running, or one whose check did not pass.

import type { BoardTask } from '@/lib/boardClient'

import { isSameDay, startOfDay, taskAnchor } from './calendar/calendarModel'

export type FinishStatus = 'done' | 'cancelled'

export function isFinishStatus(status: string): status is FinishStatus {
  return status === 'done' || status === 'cancelled'
}

interface VerdictCell {
  status?: unknown
  attempts?: Array<{ deterministic?: { passed?: unknown } | null } | null> | null
}

/**
 * Whether a stored verdict holds a move to Done, the same rule the server applies
 * (`isVerdictPromotable` in @clawboo/governance, kept in step by a parity test).
 * A pass lets it through, and so does debt whose last deterministic check passed.
 * No verdict, or one that cannot be read, holds nothing: the task is unverified,
 * not failing. A readable value that is not a verdict holds it, as on the server.
 */
export function verdictHoldsDone(task: BoardTask): boolean {
  const v = task['verification']
  if (!v) return false
  let parsed: VerdictCell
  try {
    parsed = (typeof v === 'string' ? JSON.parse(v) : v) as VerdictCell
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return true
  if (parsed.status === 'pass') return false
  if (parsed.status === 'completed_with_debt') {
    const attempts = parsed.attempts ?? []
    const last = attempts[attempts.length - 1]
    return last?.deterministic?.passed !== true
  }
  return true
}

/** The day the card sits on now, or null when that is today. A card stamped
 *  ahead of this clock (the server's clock is ahead of the browser's) counts as
 *  today: a person cannot finish work on a day that has not come. */
export function sitsOnOtherDay(task: BoardTask, now: number): number | null {
  const at = taskAnchor(task, now)
  return at > now || isSameDay(at, now) ? null : startOfDay(at)
}

/** When the task was added, or null when the row does not say. */
export function createdAtOf(task: BoardTask): number | null {
  const v = task['createdAt']
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** When its current run started, or null when nothing is running it. */
export function runningSinceOf(task: BoardTask): number | null {
  const v = task['runningSince']
  return typeof v === 'number' && v > 0 ? v : null
}

export interface FinishPromptNeed {
  to: FinishStatus
  /** The card sits on a day other than today. */
  otherDay: boolean
  /** An agent's run is working on it. */
  running: boolean
  /** Its stored check holds a move to Done. */
  failedCheck: boolean
}

/** The agent whose run is working on the task right now, or null. */
export function runningAgentId(task: BoardTask): string | null {
  const assignee = typeof task.assigneeAgentId === 'string' ? task.assigneeAgentId : null
  return assignee && runningSinceOf(task) != null ? assignee : null
}

/** What a move of `task` to `to` would have to ask about. */
export function finishNeedFor(task: BoardTask, to: FinishStatus, now: number): FinishPromptNeed {
  return {
    to,
    otherDay: sitsOnOtherDay(task, now) != null,
    running: runningAgentId(task) != null,
    failedCheck: to === 'done' && verdictHoldsDone(task),
  }
}

/** Whether the move asks first: Cancelled always does; Done does when there is a
 *  day to pick, a run to stop or a failed check to override. */
export function finishPromptNeeded(need: FinishPromptNeed): boolean {
  if (need.to === 'cancelled') return true
  return need.otherDay || need.running || need.failedCheck
}

/**
 * The finish time to record for a picked `day`: now when it is today, else the
 * same time of day on that day, so the card's time reads naturally. Never before
 * the task was added, since it cannot finish before it existed.
 */
export function finishInstant(day: number, createdAt: number | null, now: number): number {
  if (isSameDay(day, now)) return now
  const at = new Date(day)
  const clock = new Date(now)
  at.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), 0)
  const t = at.getTime()
  if (createdAt != null && t < createdAt) return Math.min(createdAt, now)
  return Math.min(t, now)
}
