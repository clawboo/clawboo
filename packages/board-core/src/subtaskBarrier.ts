// ─── A task that hands out work waits for it ────────────────────────────────
// What each of a task's sub-tasks means to the task waiting on it, read from the
// board alone, so a restart changes nothing. Closed is decided here, once:
//
//   · done, cancelled      closed;
//   · not coming           a run ended badly, it was parked, or a person put it in
//                          Backlog. Nothing more comes from it without a person, so
//                          it counts as closed, not done, and its delegator hears;
//   · stopped              a person's Stop. Not closed in the sense that ends a wait,
//                          because nothing starts after a Stop. A pause is not one: a
//                          run it stopped comes back by itself on resume, so that
//                          sub-task is still coming;
//   · with a person        waiting on a person's answer or action, or held by one.
//                          It starts again by itself when they act, so it is open;
//   · coming               it reports by itself. That includes a task waiting in To do
//                          for its next try: a provider failure's wait, or room in a
//                          budget that runs already going have set aside;
//   · not handed out       nobody was given it. An agent's note to itself, or a
//                          person's: no one is working on it, so nothing waits on it;
//   · waits on this task   it needs this task to finish first. Waiting on it back
//                          would hold both for good, so this task does not wait, and
//                          its finishing is what frees it.
//
// Import-free apart from its siblings, like the state machine.

import {
  BUDGET_HELD_STATUS,
  budgetRefusalOf,
  delegationTargetOf,
  ledgerWillAutoFire,
  stoppedByPause,
  type LedgerRun,
} from './dispatch'
import { parseWaitingOn } from './waitingOn'

export type SubtaskStanding =
  | 'done'
  | 'cancelled'
  | 'not_coming'
  | 'stopped'
  | 'with_person'
  | 'coming'
  | 'not_handed_out'
  | 'waits_on_this'

export interface SubtaskView {
  id: string
  title?: string | null
  status: string
  dropped?: boolean | number | null
  waitingOn?: unknown
  sourceDelegationId?: string | null
  assigneeAgentId?: string | null
  assigneePersonId?: string | null
  /** The task's ledger, oldest run first. Null when it could not be read. */
  execs: readonly LedgerRun[] | null
  /** It needs the task it is under to finish first: a wait, a dependency, or a chain
   *  of them leads back there. */
  waitsOnThisTask?: boolean
}

/** What one sub-task means to the task waiting on it. */
export function subtaskStanding(task: SubtaskView): SubtaskStanding {
  if (task.status === 'done') return 'done'
  if (task.status === 'cancelled' || task.dropped) return 'cancelled'
  if (task.waitsOnThisTask) return 'waits_on_this'
  if (task.assigneePersonId) return 'with_person'
  const given = !!task.assigneeAgentId || delegationTargetOf(task.sourceDelegationId) !== null
  if (!given) return 'not_handed_out'
  const wait = parseWaitingOn(task.waitingOn)
  switch (task.status) {
    case 'backlog':
      return 'not_coming'
    case 'blocked':
      if (wait?.kind === 'task' || wait?.kind === 'subtasks') return 'coming'
      if (wait?.kind === 'question' || wait?.kind === 'approval' || wait?.kind === 'person')
        return 'with_person'
      return 'not_coming'
    case 'in_review':
      return wait?.kind === 'person' ? 'with_person' : 'coming'
    case 'todo': {
      // Unread is not empty: nothing here may start a parent's follow-up early.
      if (task.execs === null) return 'coming'
      const last = task.execs[task.execs.length - 1]
      // Its run is still closing: a task going back for a retry moves before its run
      // closes, and whatever comes next, it has not ended yet.
      if (last?.status === 'running') return 'coming'
      // A hard cap's refusal goes again once a person raises it. Room runs already going
      // set aside clears by itself, so that reads like any other wait for a next try.
      if (last?.status !== BUDGET_HELD_STATUS && budgetRefusalOf(last)) return 'with_person'
      // A pause holds it back, and it fires again on resume: not a person's Stop.
      if (stoppedByPause(last)) return 'coming'
      if (last?.status === 'cancelled') return 'stopped'
      return ledgerWillAutoFire(task.execs) ? 'coming' : 'not_coming'
    }
    default:
      return 'coming'
  }
}

export interface SubtaskTally {
  done: number
  cancelled: number
  notComing: number
  stopped: number
  withPerson: number
  coming: number
  notHandedOut: number
  waitsOnThis: number
}

export function tallySubtasks(tasks: readonly SubtaskView[]): SubtaskTally {
  const t: SubtaskTally = {
    done: 0,
    cancelled: 0,
    notComing: 0,
    stopped: 0,
    withPerson: 0,
    coming: 0,
    notHandedOut: 0,
    waitsOnThis: 0,
  }
  for (const task of tasks) {
    const s = subtaskStanding(task)
    if (s === 'done') t.done += 1
    else if (s === 'cancelled') t.cancelled += 1
    else if (s === 'not_coming') t.notComing += 1
    else if (s === 'stopped') t.stopped += 1
    else if (s === 'with_person') t.withPerson += 1
    else if (s === 'coming') t.coming += 1
    else if (s === 'waits_on_this') t.waitsOnThis += 1
    else t.notHandedOut += 1
  }
  return t
}

/** Must a run that ended well wait for this work before its task can close? */
export function subtasksStillOut(t: SubtaskTally): boolean {
  return t.coming + t.withPerson > 0
}

/**
 * Is a wait on these sub-tasks over, so its task's agent gets its follow-up turn? Not
 * while one was stopped: a Stop must not start a turn, and a person's Retry of that
 * sub-task puts it back in play. An agent that chose to wait on all its sub-tasks also
 * waits for the ones nobody was given: it is waiting for a person to give them to
 * someone. The engine's own wait (`handedOutOnly`) is on what was handed out.
 */
export function subtaskWaitOver(t: SubtaskTally, opts: { handedOutOnly?: boolean } = {}): boolean {
  if (subtasksStillOut(t) || t.stopped > 0) return false
  return opts.handedOutOnly === true || t.notHandedOut === 0
}

/** Sub-tasks that ended without getting done. A cancelled one was somebody's decision. */
export function unfinishedSubtasks(t: SubtaskTally): number {
  return t.notComing + t.stopped
}

/** The sub-tasks with these standings, as a person reads them. */
export function subtaskNames(
  views: readonly SubtaskView[],
  ...standings: readonly SubtaskStanding[]
): string {
  return views
    .filter((v) => standings.includes(subtaskStanding(v)))
    .map((v) => `“${(v.title ?? '').slice(0, 60)}”`)
    .join(', ')
}

/** What a person is told when a task's agent has had its turn and work it handed out
 *  did not finish. The board keeps it true as those sub-tasks come back. */
export function unfinishedNeed(views: readonly SubtaskView[]): string {
  const names = subtaskNames(views, 'not_coming', 'stopped')
  return `${names} did not finish. Retry them, or mark this task done.`.slice(0, 1_000)
}
