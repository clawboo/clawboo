// A person moving a card on the board, at the repository layer: the finish time
// they give for a move to done or cancelled, the `actor` the lifecycle event
// carries (the engine reads it as "a person decided this"), the rule that a
// finish time is written once, and the "stranded in progress" state a card
// dragged into In progress by hand ends up in (no agent, no run).

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { encodeHumanAssignment } from '@clawboo/board-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { attentionForTask } from '../attention'
import { onBoardLifecycle, resetBoardLifecycleListeners, type BoardLifecycleEvent } from '../events'
import {
  assignTaskDelegation,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getTask,
  isStrandedInProgress,
  updateStatus,
} from '../repository'
import { updateTaskBody } from '../schemas'

let dir: string
let db: ClawbooDb
let seen: BoardLifecycleEvent[]

const CREATED_AT = 1_000_000
const MIN = 60_000
const BOUND = 'r1:deleg:agent:a2:reflectTo:leader'

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-person-move-'))
  db = createDb(path.join(dir, 'test.db'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(CREATED_AT)
  seen = []
  onBoardLifecycle((ev) => seen.push(ev))
})

afterEach(() => {
  resetBoardLifecycleListeners()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** A task created at CREATED_AT and being worked (in progress, so done is a
 *  legal move), with the clock then moved to `now`. */
function taskCreatedThen(now: number, title = 'write the brief') {
  const t = createTask(db, { title, teamId: 'T', sourceDelegationId: BOUND })
  claimTask(db, t.id, 'a2')
  vi.setSystemTime(now)
  return t
}

const statusEvents = () => seen.filter((e) => e.kind === 'status_changed')

describe('updateStatus: a finish time from the person', () => {
  it('records the given finish time on a move to done', () => {
    const t = taskCreatedThen(CREATED_AT + 10 * MIN)
    const res = updateStatus(db, t.id, 'done', { completedAt: CREATED_AT + 2 * MIN })
    expect(res.ok).toBe(true)
    expect(getTask(db, t.id)?.completedAt).toBe(CREATED_AT + 2 * MIN)
  })

  it('records it on a move to cancelled too', () => {
    const t = taskCreatedThen(CREATED_AT + 10 * MIN)
    expect(updateStatus(db, t.id, 'cancelled', { completedAt: CREATED_AT + MIN }).ok).toBe(true)
    expect(getTask(db, t.id)?.completedAt).toBe(CREATED_AT + MIN)
  })

  it('accepts the creation instant itself as the earliest finish', () => {
    const t = taskCreatedThen(CREATED_AT + MIN)
    expect(updateStatus(db, t.id, 'done', { completedAt: CREATED_AT }).ok).toBe(true)
    expect(getTask(db, t.id)?.completedAt).toBe(CREATED_AT)
  })

  it('refuses a finish before the task existed, and writes nothing', () => {
    const t = taskCreatedThen(CREATED_AT + MIN)
    seen.length = 0
    expect(updateStatus(db, t.id, 'done', { completedAt: CREATED_AT - 1 })).toEqual({
      ok: false,
      reason: 'invalid_completed_at',
    })
    expect(getTask(db, t.id)).toMatchObject({ status: 'in_progress', completedAt: null })
    expect(statusEvents()).toEqual([])
  })

  it('refuses a finish further ahead than the clock-skew allowance', () => {
    const now = CREATED_AT + 10 * MIN
    const t = taskCreatedThen(now)
    expect(updateStatus(db, t.id, 'cancelled', { completedAt: now + 5 * MIN + 1 })).toEqual({
      ok: false,
      reason: 'invalid_completed_at',
    })
    expect(getTask(db, t.id)?.status).toBe('in_progress')
  })

  it('refuses a finish time that is not a number at all', () => {
    const t = taskCreatedThen(CREATED_AT + MIN)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(updateStatus(db, t.id, 'done', { completedAt: bad })).toMatchObject({
        reason: 'invalid_completed_at',
      })
    }
  })

  it('clamps a finish slightly in the future (clock skew) to now', () => {
    const now = CREATED_AT + 10 * MIN
    const t = taskCreatedThen(now)
    // Inside the window, and exactly at its edge: both land, both read as now.
    expect(updateStatus(db, t.id, 'done', { completedAt: now + 2 * MIN }).ok).toBe(true)
    expect(getTask(db, t.id)?.completedAt).toBe(now)

    const edge = taskCreatedThen(now, 'edge')
    expect(updateStatus(db, edge.id, 'done', { completedAt: now + 5 * MIN }).ok).toBe(true)
    expect(getTask(db, edge.id)?.completedAt).toBe(now)
  })

  it('stamps now when no finish time is given', () => {
    const now = CREATED_AT + 3 * MIN
    const t = taskCreatedThen(now)
    updateStatus(db, t.id, 'done')
    expect(getTask(db, t.id)?.completedAt).toBe(now)
  })

  it('ignores a finish time on a move that does not finish the task', () => {
    const t = taskCreatedThen(CREATED_AT + MIN)
    // Even an out-of-range value is not checked: it has no meaning here.
    expect(updateStatus(db, t.id, 'blocked', { completedAt: CREATED_AT - 5 }).ok).toBe(true)
    expect(getTask(db, t.id)).toMatchObject({ status: 'blocked', completedAt: null })
  })
})

describe('updateStatus: the finish time is written once', () => {
  it('a second done (a late run result) keeps the first finish time', () => {
    const t = taskCreatedThen(CREATED_AT + MIN)
    updateStatus(db, t.id, 'done', { actor: 'person' })
    const first = getTask(db, t.id)!.completedAt
    expect(first).toBe(CREATED_AT + MIN)

    vi.setSystemTime(CREATED_AT + 30 * MIN)
    expect(updateStatus(db, t.id, 'done').ok).toBe(true)
    expect(getTask(db, t.id)?.completedAt).toBe(first)
  })

  it('a second cancel with a finish time does not move the first one either', () => {
    const t = taskCreatedThen(CREATED_AT + 4 * MIN)
    updateStatus(db, t.id, 'cancelled')
    vi.setSystemTime(CREATED_AT + 20 * MIN)
    expect(updateStatus(db, t.id, 'cancelled', { completedAt: CREATED_AT + 10 * MIN }).ok).toBe(
      true,
    )
    expect(getTask(db, t.id)?.completedAt).toBe(CREATED_AT + 4 * MIN)
  })
})

describe('updateStatus: who moved the card', () => {
  it('carries actor "person" on the status event when the caller says so', () => {
    const t = taskCreatedThen(CREATED_AT)
    seen.length = 0
    updateStatus(db, t.id, 'cancelled', { actor: 'person' })
    expect(statusEvents()).toEqual([
      { kind: 'status_changed', taskId: t.id, teamId: 'T', status: 'cancelled', actor: 'person' },
    ])
  })

  it('leaves actor off for every other writer', () => {
    const t = taskCreatedThen(CREATED_AT)
    seen.length = 0
    updateStatus(db, t.id, 'blocked')
    const [ev] = statusEvents()
    expect(ev).toEqual({ kind: 'status_changed', taskId: t.id, teamId: 'T', status: 'blocked' })
    expect(ev).not.toHaveProperty('actor')
  })

  it('a refused move publishes nothing, even from a person', () => {
    const t = taskCreatedThen(CREATED_AT)
    updateStatus(db, t.id, 'done')
    seen.length = 0
    // done is terminal: done -> todo is illegal.
    expect(updateStatus(db, t.id, 'todo', { actor: 'person' }).ok).toBe(false)
    expect(statusEvents()).toEqual([])
  })
})

describe('isStrandedInProgress', () => {
  /** A card dragged from To do into In progress: nothing claimed it. */
  function draggedIntoInProgress(title = 'dragged') {
    const t = createTask(db, { title, teamId: 'T', sourceDelegationId: BOUND })
    updateStatus(db, t.id, 'in_progress', { actor: 'person' })
    return getTask(db, t.id)!
  }

  it('is true for an in-progress card with no agent and no run', () => {
    expect(isStrandedInProgress(db, draggedIntoInProgress())).toBe(true)
  })

  it('stays true once its last run has finished', () => {
    const t = draggedIntoInProgress()
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    completeExecutionProcess(db, ex.id, { status: 'cancelled' })
    expect(isStrandedInProgress(db, t)).toBe(true)
  })

  it('is false while a run is going, even with no agent on the card', () => {
    const t = draggedIntoInProgress()
    createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    expect(isStrandedInProgress(db, t)).toBe(false)
  })

  it('is false when an agent claimed it, and for any other status', () => {
    const claimed = createTask(db, { title: 'claimed', teamId: 'T', sourceDelegationId: BOUND })
    claimTask(db, claimed.id, 'a2')
    expect(isStrandedInProgress(db, getTask(db, claimed.id)!)).toBe(false)

    const queued = createTask(db, { title: 'queued', teamId: 'T' })
    expect(isStrandedInProgress(db, queued)).toBe(false)
    updateStatus(db, queued.id, 'blocked')
    expect(isStrandedInProgress(db, getTask(db, queued.id)!)).toBe(false)
  })

  it('reads as "unstarted" on the board, and stops once a run is going', () => {
    const t = draggedIntoInProgress()
    expect(attentionForTask(db, t.id)).toEqual({ reason: 'unstarted', failedRuns: 0 })
    createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    expect(attentionForTask(db, t.id)).toBeNull()
  })

  it('a claimed in-progress task never reads as unstarted', () => {
    const t = createTask(db, { title: 'worked', teamId: 'T', sourceDelegationId: BOUND })
    claimTask(db, t.id, 'a2')
    expect(attentionForTask(db, t.id)).toBeNull()
  })
})

describe('assignTaskDelegation on an in-progress card', () => {
  it('hands a stranded card to an agent and puts it back to todo in one write', () => {
    const t = createTask(db, { title: 'dragged', teamId: 'T' })
    updateStatus(db, t.id, 'in_progress', { actor: 'person' })
    seen.length = 0
    const sdid = encodeHumanAssignment('a3', 'n1')
    expect(assignTaskDelegation(db, t.id, sdid)).toMatchObject({ ok: true, from: 'in_progress' })
    expect(getTask(db, t.id)).toMatchObject({
      status: 'todo',
      sourceDelegationId: sdid,
      assigneeAgentId: null,
    })
    expect(statusEvents()).toEqual([
      { kind: 'status_changed', taskId: t.id, teamId: 'T', status: 'todo' },
    ])
  })

  it('refuses while a run is going on it, so the run keeps its task', () => {
    const t = createTask(db, { title: 'running', teamId: 'T', sourceDelegationId: BOUND })
    updateStatus(db, t.id, 'in_progress')
    createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    seen.length = 0
    expect(assignTaskDelegation(db, t.id, encodeHumanAssignment('a3', 'n1'))).toEqual({
      ok: false,
      reason: 'not_assignable',
    })
    expect(getTask(db, t.id)).toMatchObject({ status: 'in_progress', sourceDelegationId: BOUND })
    expect(seen).toEqual([])
  })
})

describe('updateTaskBody: completedAt', () => {
  it('goes with a move to done or cancelled only', () => {
    expect(updateTaskBody.safeParse({ status: 'done', completedAt: 5 }).success).toBe(true)
    expect(updateTaskBody.safeParse({ status: 'cancelled', completedAt: 5 }).success).toBe(true)
    expect(updateTaskBody.safeParse({ status: 'todo', completedAt: 5 }).success).toBe(false)
    expect(updateTaskBody.safeParse({ completedAt: 5 }).success).toBe(false)
  })

  it('must be a positive whole number of milliseconds', () => {
    for (const completedAt of [0, -1, 1.5]) {
      expect(updateTaskBody.safeParse({ status: 'done', completedAt }).success).toBe(false)
    }
  })
})

describe('an agent’s status write after a person moved the card', () => {
  /** A task whose run started at `runAt` (a claim and an execution). */
  function runStartedAt(runAt: number) {
    vi.setSystemTime(runAt)
    const t = createTask(db, { title: 'draft the post', teamId: 'T', sourceDelegationId: BOUND })
    claimTask(db, t.id, 'a2')
    createExecutionProcess(db, { taskId: t.id, executorType: 'claude-code' })
    return t
  }

  it('records when a person moved the card, and only a person', () => {
    const t = runStartedAt(CREATED_AT)
    vi.setSystemTime(CREATED_AT + MIN)
    expect(updateStatus(db, t.id, 'blocked').ok).toBe(true)
    expect(getTask(db, t.id)?.personMovedAt).toBeNull()
    vi.setSystemTime(CREATED_AT + 2 * MIN)
    expect(updateStatus(db, t.id, 'todo', { actor: 'person' }).ok).toBe(true)
    expect(getTask(db, t.id)?.personMovedAt).toBe(CREATED_AT + 2 * MIN)
  })

  it('refuses the overruled run’s write, naming where the person put the card', () => {
    const t = runStartedAt(CREATED_AT)
    vi.setSystemTime(CREATED_AT + MIN)
    expect(updateStatus(db, t.id, 'todo', { actor: 'person' }).ok).toBe(true)
    vi.setSystemTime(CREATED_AT + 2 * MIN)
    // In progress is a legal move from To do, so only the guard stops it.
    const r = updateStatus(db, t.id, 'in_progress', { unlessPersonMoved: true })
    expect(r).toMatchObject({ ok: false, reason: 'person_moved' })
    expect(r.task?.status).toBe('todo')
    expect(getTask(db, t.id)?.status).toBe('todo')
  })

  it('lets a run started after the move write as usual', () => {
    const t = runStartedAt(CREATED_AT)
    vi.setSystemTime(CREATED_AT + MIN)
    expect(updateStatus(db, t.id, 'todo', { actor: 'person' }).ok).toBe(true)
    vi.setSystemTime(CREATED_AT + 2 * MIN)
    claimTask(db, t.id, 'a2')
    createExecutionProcess(db, { taskId: t.id, executorType: 'claude-code' })
    vi.setSystemTime(CREATED_AT + 3 * MIN)
    expect(updateStatus(db, t.id, 'blocked', { unlessPersonMoved: true }).ok).toBe(true)
  })

  it('leaves a write alone when no person moved the card, or when it is not an agent’s', () => {
    const t = runStartedAt(CREATED_AT)
    vi.setSystemTime(CREATED_AT + MIN)
    expect(updateStatus(db, t.id, 'blocked', { unlessPersonMoved: true }).ok).toBe(true)
    expect(updateStatus(db, t.id, 'todo', { actor: 'person' }).ok).toBe(true)
    // The engine and the board's own writes carry no flag and are not refused.
    vi.setSystemTime(CREATED_AT + 2 * MIN)
    expect(updateStatus(db, t.id, 'blocked').ok).toBe(true)
  })

  it('refuses a write on a card a person moved that never ran', () => {
    vi.setSystemTime(CREATED_AT)
    const t = createTask(db, { title: 'loose idea', teamId: 'T', status: 'todo' })
    vi.setSystemTime(CREATED_AT + MIN)
    expect(updateStatus(db, t.id, 'backlog', { actor: 'person' }).ok).toBe(true)
    expect(updateStatus(db, t.id, 'todo', { unlessPersonMoved: true }).reason).toBe('person_moved')
  })
})
