// What follows a PERSON moving a task's card on the board (the board PATCH),
// after the move is written. A person's move is the final word on the run that
// was working on the task, so the run is stopped instead of left to spend and to
// report a result that contradicts the board. Whoever delegated the task hears
// what the person decided.
//
// Two kinds of run can be working on a task: one the team engine started (a
// delegation, a plan step, a person's assignment), and one started outside it (a
// routine fire, through the executor runner or the OpenClaw routine dispatcher,
// or a direct runtime run). The engine stops its own and reports to the
// delegator; the others are stopped here, through the run-stop registry. With
// no engine alive for the team, the delegator gets a durable mailbox notice
// instead, which it reads at its next turn rather than being woken for it.

import { enqueueInbox, getTask, type ClawbooDb } from '@clawboo/db'
import { isHumanAssignment } from '@clawboo/board-core'
import { createLogger } from '@clawboo/logger'

import { stopTaskRuns } from '../runStops'
import { getTeamOrchestrator, hasTeamOrchestrator } from './teamOrchestrator'

const log = createLogger('human-move')

/** Mirrors the engine's `:reflectTo:` sdid segment (see inboxNotices). */
const SDID_REFLECT_TO_RE = /:reflectTo:([^:]+)/

const STATUS_WORD: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}

/** A status as the board labels it. */
export function statusWord(status: string): string {
  return STATUS_WORD[status] ?? status
}

export interface HumanMove {
  taskId: string
  teamId: string | null
  from: string | null
  to: string
  /** Plan steps cancelled with the task, which the delegator hears about too. */
  cancelledDependents?: Array<{ id: string; title?: string | null }>
}

export function noteHumanMove(db: ClawbooDb, move: HumanMove): void {
  const { taskId, teamId, to } = move
  if (to === 'in_progress' || to === 'in_review') return
  try {
    stopTaskRuns(taskId, `Stopped: a person moved the card to ${statusWord(to)}.`)
  } catch (err) {
    log.error({ err, taskId }, 'stopping a run for a person’s move failed')
  }
  if (!teamId) return
  if (hasTeamOrchestrator(teamId)) {
    void getTeamOrchestrator(teamId, { mcpBaseUrl: null })
      .personMovedTask(taskId, to, { cancelledDependents: move.cancelledDependents ?? [] })
      .catch((err: unknown) => log.error({ err, taskId, teamId }, 'person-move handling failed'))
    return
  }
  if (to !== 'done' && to !== 'cancelled') return
  try {
    const task = getTask(db, taskId)
    const sdid = (task?.sourceDelegationId as string | null) ?? ''
    if (isHumanAssignment(sdid)) return
    const delegator = sdid.match(SDID_REFLECT_TO_RE)?.[1]
    if (!delegator) return
    const title = task?.title ?? taskId
    const steps = (move.cancelledDependents ?? []).length
    enqueueInbox(db, {
      agentId: delegator,
      teamId,
      kind: 'task_update',
      taskId,
      body:
        to === 'done'
          ? `A person marked “${title}” done on the board.`
          : `A person cancelled “${title}” on the board. Do not redo it or hand it to anyone again.${
              steps > 0
                ? ` ${steps === 1 ? 'One later step' : `${steps} later steps`} waiting on it ${steps === 1 ? 'was' : 'were'} cancelled too.`
                : ''
            }`,
    })
  } catch (err) {
    log.error({ err, taskId }, 'person-move notice failed')
  }
}
