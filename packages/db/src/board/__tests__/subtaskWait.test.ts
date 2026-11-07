// A task that handed out work waits on it from the board alone: its release is in the
// write that closes the last sub-task, or in the pump's pass for what no such write
// marks, so no process has to remember anything. And an agent's report is stored for
// the run that made it, with no status moved.

import { parseWaitingOn, PAUSED_RUN_CLASS } from '@clawboo/board-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { eq } from 'drizzle-orm'

import { createDb, type ClawbooDb } from '../../db'
import { tasks } from '../../schema'
import { listWaitingTaskWakes } from '../../taskWakes'
import { attentionForTask } from '../attention'
import { liftPause, placePause } from '../pauses'
import {
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createSubtask,
  createTask,
  getComments,
  getTask,
  linkDep,
  listExecutions,
  releaseFinishedSubtaskWaits,
  subtaskViewsOf,
  updateStatus,
  waitingOnDetailOf,
} from '../repository'
import { readResultClaim, recordResultClaim } from '../resultClaim'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const agentSdid = (agent: string, from = 'a2'): string =>
  `run-1:deleg:agent:${agent}:reflectTo:${from}`

/** A parent its agent worked on, with sub-tasks handed out, parked as the engine parks it. */
function parentWith(n: number): { parent: string; subs: string[] } {
  const t = createTask(db, {
    title: 'Parent',
    teamId: 'T',
    status: 'todo',
    sourceDelegationId: agentSdid('a2', 'leader'),
  })
  const claim = claimTask(db, t.id, 'a2', 'openclaw', { run: { executorType: 'openclaw' } })
  completeExecutionProcess(db, claim.execution!.id, { status: 'succeeded', summary: 'handed out' })
  const subs = Array.from(
    { length: n },
    (_, i) =>
      createSubtask(db, t.id, {
        title: `Part ${i}`,
        status: 'todo',
        sourceDelegationId: agentSdid(`b${i}`),
      }).id,
  )
  expect(
    updateStatus(db, t.id, 'blocked', { waitingOn: { kind: 'subtasks', handedOut: true } }).ok,
  ).toBe(true)
  return { parent: t.id, subs }
}
const start = (id: string, agent = 'b0'): string =>
  claimTask(db, id, agent, 'openclaw', { run: { executorType: 'openclaw' } }).execution!.id
const finish = (id: string): void => {
  const exec = start(id)
  completeExecutionProcess(db, exec, { status: 'succeeded', summary: 'ok' })
  updateStatus(db, id, 'done')
}
const fail = (id: string): void => {
  const exec = start(id)
  updateStatus(db, id, 'blocked', { waitingOn: { kind: 'failure' } })
  completeExecutionProcess(db, exec, { status: 'failed', error: 'boom' })
}

describe('the release, in the write that closes the work', () => {
  it('waits for the last one, and the parent is out of Needs you meanwhile', () => {
    const { parent, subs } = parentWith(2)
    finish(subs[0]!)
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(attentionForTask(db, parent)).toBeNull()
    expect(listWaitingTaskWakes(db, { taskId: parent })).toHaveLength(0)
  })

  it('all done: back to the queue with a wake that says why', () => {
    const { parent, subs } = parentWith(2)
    subs.forEach(finish)
    const row = getTask(db, parent)
    expect(row?.status).toBe('todo')
    expect(row?.waitingOn).toBeNull()
    expect(listWaitingTaskWakes(db, { taskId: parent }).map((w) => w.reason)).toEqual([
      'subtasks_closed',
    ])
    expect(getComments(db, parent).at(-1)?.body).toMatch(/are done/)
  })

  it('a sub-task that failed ends the wait, and the note does not read as success', () => {
    const { parent, subs } = parentWith(2)
    finish(subs[0]!)
    expect(getTask(db, parent)?.status).toBe('blocked')
    fail(subs[1]!)
    expect(getTask(db, parent)?.status).toBe('todo')
    expect(listWaitingTaskWakes(db, { taskId: parent }).map((w) => w.reason)).toEqual([
      'subtasks_closed',
    ])
    expect(getComments(db, parent).at(-1)?.body).toMatch(/not all of them got done/)
  })

  it('a failure with another sub-task still going leaves the wait as it is', () => {
    const { parent, subs } = parentWith(2)
    fail(subs[0]!)
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, parent)?.waitingOn)?.kind).toBe('subtasks')
  })

  it('a sub-task waiting on a person keeps the parent waiting, and the card says so', () => {
    const { parent, subs } = parentWith(2)
    finish(subs[0]!)
    start(subs[1]!, 'b1')
    updateStatus(db, subs[1]!, 'blocked', {
      waitingOn: { kind: 'person', need: 'log in', by: 'agent' },
    })
    expect(getTask(db, parent)?.status).toBe('blocked')
    const row = getTask(db, parent)!
    expect(waitingOnDetailOf(db, row)).toEqual({ openSubtasks: 1, needPerson: 1 })
    // The sub-task is what a person acts on, and it is in Needs you.
    expect(attentionForTask(db, subs[1]!)?.reason).toBe('blocked')
  })

  it('the wait does not count work nobody was given, as the card does not', () => {
    const { parent, subs } = parentWith(1)
    createSubtask(db, parent, { title: 'A note to self', status: 'todo' })
    expect(waitingOnDetailOf(db, getTask(db, parent)!)).toEqual({ openSubtasks: 1 })
    finish(subs[0]!)
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('a run still open on the parent is left to end first, and the pass picks it up', () => {
    const { parent, subs } = parentWith(1)
    const open = createExecutionProcess(db, { taskId: parent, executorType: 'openclaw' })
    finish(subs[0]!)
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, parent)?.waitingOn)?.kind).toBe('subtasks')
    completeExecutionProcess(db, open.id, { status: 'succeeded' })
    expect(releaseFinishedSubtaskWaits(db)).toBe(1)
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('a parent no agent is bound to goes to a person, who is told why', () => {
    const t = createTask(db, { title: 'Parent', teamId: 'T', status: 'todo' })
    claimTask(db, t.id, 'a2')
    const s = createSubtask(db, t.id, {
      title: 'Part',
      status: 'todo',
      sourceDelegationId: agentSdid('b0'),
    })
    updateStatus(db, t.id, 'blocked', { waitingOn: { kind: 'subtasks', handedOut: true } })
    finish(s.id)
    expect(getTask(db, t.id)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, t.id)?.waitingOn)).toMatchObject({ kind: 'person' })
    expect(attentionForTask(db, t.id)?.reason).toBe('blocked')
  })
})

describe('the pass, for what no closing write marks', () => {
  it('a sub-task parked after failing three times ends the wait', () => {
    const { parent, subs } = parentWith(1)
    for (let i = 0; i < 3; i++) {
      const exec = createExecutionProcess(db, { taskId: subs[0]!, executorType: 'openclaw' })
      completeExecutionProcess(db, exec.id, { status: 'failed', error: 'boom' })
    }
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(releaseFinishedSubtaskWaits(db)).toBe(1)
    expect(getTask(db, parent)?.status).toBe('todo')
    // Once.
    expect(releaseFinishedSubtaskWaits(db)).toBe(0)
  })

  it('a stopped sub-task never starts a parent', () => {
    const { parent, subs } = parentWith(2)
    finish(subs[0]!)
    const exec = createExecutionProcess(db, { taskId: subs[1]!, executorType: 'openclaw' })
    completeExecutionProcess(db, exec.id, { status: 'cancelled', byPerson: true })
    expect(releaseFinishedSubtaskWaits(db)).toBe(0)
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(listWaitingTaskWakes(db, { taskId: parent })).toHaveLength(0)
    expect(waitingOnDetailOf(db, getTask(db, parent)!)).toEqual({ openSubtasks: 1, needPerson: 1 })
  })

  it('leaves a parent with work still going alone', () => {
    const { parent } = parentWith(1)
    expect(releaseFinishedSubtaskWaits(db)).toBe(0)
    expect(getTask(db, parent)?.status).toBe('blocked')
  })

  it('reads the sub-tasks with their ledgers, for the engine', () => {
    const { parent, subs } = parentWith(1)
    const exec = createExecutionProcess(db, { taskId: subs[0]!, executorType: 'openclaw' })
    completeExecutionProcess(db, exec.id, { status: 'cancelled', byPerson: true })
    expect(subtaskViewsOf(db, parent)).toMatchObject([
      { id: subs[0], status: 'todo', execs: [{ status: 'cancelled' }] },
    ])
  })
})

describe('an agent’s report', () => {
  const running = (): { taskId: string; execId: string } => {
    const t = createTask(db, {
      title: 'Work',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: agentSdid('a2', 'leader'),
    })
    const claim = claimTask(db, t.id, 'a2', 'openclaw', { run: { executorType: 'openclaw' } })
    return { taskId: t.id, execId: claim.execution!.id }
  }
  const claim = { outcome: 'not_done', summary: 'No key for the API.' } as const

  it('is stored for the run, and moves nothing', () => {
    const { taskId, execId } = running()
    expect(recordResultClaim(db, taskId, 'a2', claim)).toEqual({ ok: true })
    expect(readResultClaim(db, execId)).toEqual(claim)
    expect(getTask(db, taskId)?.status).toBe('in_progress')
    expect(getComments(db, taskId)).toHaveLength(0)
  })

  it('the last one the run made stands', () => {
    const { taskId, execId } = running()
    recordResultClaim(db, taskId, 'a2', claim)
    recordResultClaim(db, taskId, 'a2', { outcome: 'done', summary: 'Found a key after all.' })
    expect(readResultClaim(db, execId)?.outcome).toBe('done')
  })

  it('a next run starts with no claim', () => {
    const { taskId, execId } = running()
    recordResultClaim(db, taskId, 'a2', claim)
    completeExecutionProcess(db, execId, { status: 'succeeded' })
    updateStatus(db, taskId, 'todo')
    const next = claimTask(db, taskId, 'a2', 'openclaw', { run: { executorType: 'openclaw' } })
    expect(readResultClaim(db, next.execution!.id)).toBeNull()
    expect(listExecutions(db, taskId)).toHaveLength(2)
  })

  it('refuses another agent, a run that ended and a task that does not exist', () => {
    const { taskId, execId } = running()
    expect(recordResultClaim(db, taskId, 'a9', claim)).toEqual({ ok: false, reason: 'not_yours' })
    expect(recordResultClaim(db, 'nope', 'a2', claim)).toEqual({ ok: false, reason: 'not_found' })
    completeExecutionProcess(db, execId, { status: 'succeeded' })
    expect(recordResultClaim(db, taskId, 'a2', claim)).toEqual({ ok: false, reason: 'no_run' })
    expect(readResultClaim(db, execId)).toBeNull()
  })
})

describe('what the review found', () => {
  it('a sub-task that needs its parent first is not waited on, by any route back', () => {
    // Each made while the parent's run is going, as the guards at the time allow.
    const t = createTask(db, {
      title: 'Parent',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: agentSdid('a2', 'leader'),
    })
    const parent = t.id
    const claim = claimTask(db, parent, 'a2', 'openclaw', { run: { executorType: 'openclaw' } })
    const sub = (title: string): string =>
      createSubtask(db, parent, { title, status: 'todo', sourceDelegationId: agentSdid('b0') }).id
    const [direct, viaWait, viaDep] = [
      sub('direct'),
      sub('through a teammate'),
      sub('a dependency'),
    ]
    start(direct)
    updateStatus(db, direct, 'blocked', { waitingOn: { kind: 'task', taskId: parent } })
    start(viaWait, 'b1')
    updateStatus(db, viaWait, 'blocked', { waitingOn: { kind: 'task', taskId: direct } })
    linkDep(db, viaDep, parent)
    completeExecutionProcess(db, claim.execution!.id, { status: 'succeeded' })
    updateStatus(db, parent, 'blocked', { waitingOn: { kind: 'subtasks', handedOut: true } })
    expect(subtaskViewsOf(db, parent).map((v) => v.waitsOnThisTask)).toEqual([true, true, true])
    expect(waitingOnDetailOf(db, getTask(db, parent)!)).toEqual({ openSubtasks: 0 })
    // Nothing is coming, so the wait is over: its agent's turn, and its Done frees them.
    expect(releaseFinishedSubtaskWaits(db)).toBe(1)
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('a task that only depends on a sibling is still waited on', () => {
    const { parent, subs } = parentWith(2)
    linkDep(db, subs[1]!, subs[0]!)
    expect(subtaskViewsOf(db, parent).map((v) => v.waitsOnThisTask)).toEqual([false, false])
  })

  /** Its agent has had its turn, and the first sub-task did not finish. */
  function shortOf(n: number): { parent: string; subs: string[] } {
    const made = parentWith(n)
    fail(made.subs[0]!)
    for (const s of made.subs.slice(1)) finish(s)
    const row = getTask(db, made.parent)
    expect(row?.status).toBe('todo')
    updateStatus(db, made.parent, 'blocked', {
      waitingOn: {
        kind: 'person',
        need: '“Part 0” did not finish.',
        by: 'agent',
        untilSubtasks: true,
      },
    })
    return made
  }

  it('retrying what did not finish brings the parent back when it does', () => {
    const { parent, subs } = shortOf(2)
    expect(attentionForTask(db, parent)?.reason).toBe('blocked')
    const again = subs[0]!
    updateStatus(db, again, 'todo')
    claimTask(db, again, 'b0', 'openclaw', { run: { executorType: 'openclaw' } })
    // Running again: it stays with the person until there is an answer.
    expect(getTask(db, parent)?.status).toBe('blocked')
    updateStatus(db, again, 'done')
    expect(getTask(db, parent)?.status).toBe('todo')
    expect(getTask(db, parent)?.waitingOn).toBeNull()
    expect(listWaitingTaskWakes(db, { taskId: parent }).map((w) => w.reason)).toEqual([
      'subtasks_closed',
    ])
  })

  it('cancelling what did not finish brings it back too', () => {
    const { parent, subs } = shortOf(2)
    updateStatus(db, subs[0]!, 'cancelled', { actor: 'person' })
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('failing again keeps it with the person, and an ordinary person wait is not touched', () => {
    const { parent, subs } = shortOf(2)
    const again = subs[0]!
    updateStatus(db, again, 'todo')
    claimTask(db, again, 'b0', 'openclaw', { run: { executorType: 'openclaw' } })
    updateStatus(db, again, 'blocked', { waitingOn: { kind: 'failure' } })
    expect(getTask(db, parent)?.status).toBe('blocked')

    const other = parentWith(1)
    updateStatus(db, other.parent, 'blocked', {
      waitingOn: { kind: 'person', need: 'Log in', by: 'agent' },
    })
    finish(other.subs[0]!)
    expect(getTask(db, other.parent)?.status).toBe('blocked')
    expect(parseWaitingOn(getTask(db, other.parent)?.waitingOn)).toMatchObject({ need: 'Log in' })
  })

  it('the pass finds it too, for a sub-task a raw write closed', () => {
    const { parent, subs } = shortOf(2)
    db.update(tasks).set({ status: 'done', waitingOn: null }).where(eq(tasks.id, subs[0]!)).run()
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(releaseFinishedSubtaskWaits(db)).toBe(1)
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('a card counts as needing you only what Needs you shows', () => {
    const { parent, subs } = parentWith(3)
    const [parked, asking] = subs as [string, string, string]
    updateStatus(db, parked, 'backlog')
    expect(attentionForTask(db, parked)).toBeNull()
    start(asking, 'b1')
    updateStatus(db, asking, 'blocked', {
      waitingOn: { kind: 'person', need: 'log in', by: 'agent' },
    })
    expect(attentionForTask(db, asking)?.reason).toBe('blocked')
    expect(waitingOnDetailOf(db, getTask(db, parent)!)).toEqual({ openSubtasks: 3, needPerson: 1 })
  })
})

describe('a parent under a pause', () => {
  /** What the engine writes when a pause stops a sub-task's run. */
  const stoppedByPause = (id: string, agent: string): void => {
    completeExecutionProcess(db, start(id, agent), {
      status: 'cancelled',
      byPerson: false,
      error: 'Paused.',
      errorClass: PAUSED_RUN_CLASS,
    })
    updateStatus(db, id, 'todo')
  }

  it('waits for a sub-task a pause stopped, and reads as needing nobody', () => {
    const { parent, subs } = parentWith(2)
    finish(subs[0]!)
    stoppedByPause(subs[1]!, 'b1')
    expect(releaseFinishedSubtaskWaits(db)).toBe(0)
    const row = getTask(db, parent)!
    expect(row.status).toBe('blocked')
    expect(waitingOnDetailOf(db, row)).toEqual({ openSubtasks: 1 })
    expect(attentionForTask(db, parent)).toBeNull()
  })

  it('goes on when that sub-task closes after the resume', () => {
    const { parent, subs } = parentWith(1)
    stoppedByPause(subs[0]!, 'b0')
    finish(subs[0]!)
    expect(getTask(db, parent)?.status).toBe('todo')
    expect(listWaitingTaskWakes(db, { taskId: parent })[0]?.reason).toBe('subtasks_closed')
  })

  it('a pause on its own agent lets the wait end, and holds the run: a claim is refused', () => {
    const { parent, subs } = parentWith(1)
    placePause(db, { kind: 'agent', id: 'a2' })
    finish(subs[0]!)
    // The write only moves it to To do. Nothing starts.
    expect(getTask(db, parent)?.status).toBe('todo')
    const refused = claimTask(db, parent, 'a2', 'openclaw', { run: { executorType: 'openclaw' } })
    expect(refused).toMatchObject({ ok: false, reason: 'paused' })
    expect(listWaitingTaskWakes(db, { taskId: parent })).toHaveLength(1)
    expect(attentionForTask(db, parent)).toBeNull()

    liftPause(db, 'agent', 'a2')
    const claim = claimTask(db, parent, 'a2', 'openclaw', { run: { executorType: 'openclaw' } })
    expect(claim.ok).toBe(true)
    expect(claim.execution?.runReason).toBe('subtasks_closed')
    expect(claim.wakes?.map((w) => w.reason)).toEqual(['subtasks_closed'])
  })
})
