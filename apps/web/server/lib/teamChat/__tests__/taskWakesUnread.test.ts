// A run the pump starts for a person's comment, some time after they wrote it (a hold
// lifting, say). The card moving is their doing, so it does not come back to them as
// news. But they are not looking at the task when it happens, so anything they had not
// read stays unread. The start is the real claim, and no run follows it: what is asserted
// is the read state. `taskWakes.integration.test.ts` goes through the real engine.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { encodeHumanAssignment, LOCAL_PERSON } from '@clawboo/board-core'
import {
  addComment,
  agents,
  claimTask,
  completeExecutionProcess,
  createTask,
  getTask,
  liftPause,
  LOCAL_READER,
  markTaskRead,
  placePause,
  readAgentWakeGate,
  recordTaskWake,
  runOwnWrite,
  saveAgentCommentWake,
  setTeamAlwaysAllow,
  taskReadStates,
  teams,
  updateStatus,
  type ClawbooDb,
  type DbTask,
} from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../db'
import { pumpTaskWakes, type TaskWakePumpDeps } from '../taskWakes'

const TEAM = 'T'
const WORKER = 'a1'
const TEAMMATE = 'a2'
const PRIYA = { id: 'p-priya', name: 'Priya', role: null }

describe('the pump moving a card for a person’s comment', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let started: string[]

  const deps = (over: Partial<TaskWakePumpDeps> = {}): TaskWakePumpDeps => ({
    held: () => false,
    startForPerson: (task, agentId) => {
      started.push(task.id)
      claimTask(db, task.id, agentId, 'hermes', {
        run: { executorType: 'openclaw', engineRun: true },
      })
    },
    pumpRoom: () => undefined,
    alert: () => true,
    budgetRefuses: () => false,
    ...over,
  })

  const blockedTask = (): DbTask =>
    createTask(db, {
      title: 'fix the bug',
      teamId: TEAM,
      status: 'blocked',
      sourceDelegationId: encodeHumanAssignment(WORKER, 'n1'),
    })

  /** A person's reply, as the comment route writes it: reading the task as it goes. */
  const reply = (taskId: string, reader: string, person: typeof PRIYA | null = null): void => {
    const c = runOwnWrite(db, reader, taskId, () =>
      addComment(db, taskId, 'try the other file', 'user', null, { kind: 'person', person }),
    )
    recordTaskWake(db, {
      teamId: TEAM,
      agentId: WORKER,
      taskId,
      reason: 'person_comment',
      commentIds: [c.id],
    })
  }

  const unreadFor = (reader: string, taskId: string): boolean | undefined =>
    taskReadStates(db, reader).get(taskId)?.unread

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wake-unread-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    started = []
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: 'Team', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: WORKER,
        runtime: 'hermes',
        name: 'Ada',
        teamId: TEAM,
        gatewayId: 'gw',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetDb()
    for (const k of ['HOME', 'CLAWBOO_HOME']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    await rm(home, { recursive: true, force: true })
  })

  it('does not read as news for them once a hold lifts', () => {
    const task = blockedTask()
    reply(task.id, LOCAL_READER)
    pumpTaskWakes(db, deps({ held: () => true }))
    expect(getTask(db, task.id)?.status).toBe('blocked')
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)

    pumpTaskWakes(db, deps())

    expect(getTask(db, task.id)?.status).toBe('in_progress')
    expect(started).toEqual([task.id])
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)
  })

  it('does not read as news while the card waits in To do for its run', () => {
    const task = blockedTask()
    reply(task.id, LOCAL_READER)

    pumpTaskWakes(db, deps({ startForPerson: () => undefined }))

    expect(getTask(db, task.id)?.status).toBe('todo')
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)
  })

  it('reads as theirs for the person the comment names, and as news for anyone else', () => {
    const reader = `person:${PRIYA.id}`
    const other = 'person:p-sam'
    // Both have a read state from before any of this.
    taskReadStates(db, reader)
    taskReadStates(db, other)
    const task = blockedTask()
    reply(task.id, reader, PRIYA)

    pumpTaskWakes(db, deps())

    expect(getTask(db, task.id)?.status).toBe('in_progress')
    expect(unreadFor(reader, task.id)).toBe(false)
    expect(unreadFor(other, task.id)).toBe(true)
  })

  it('keeps what they had not read unread: they are not looking at it now', () => {
    const task = blockedTask()
    reply(task.id, LOCAL_READER)
    addComment(db, task.id, 'I found the cause', 'agent', WORKER, { kind: 'agent' })
    expect(unreadFor(LOCAL_READER, task.id)).toBe(true)

    pumpTaskWakes(db, deps())

    expect(getTask(db, task.id)?.status).toBe('in_progress')
    expect(unreadFor(LOCAL_READER, task.id)).toBe(true)
  })

  it('is news when a teammate is behind the move, and the wake still counts on the job', () => {
    const task = createTask(db, {
      title: 'fix the bug',
      teamId: TEAM,
      status: 'todo',
      sourceDelegationId: encodeHumanAssignment(WORKER, 'n1'),
    })
    const first = claimTask(db, task.id, WORKER, 'hermes', {
      run: { executorType: 'openclaw', engineRun: true },
    })
    completeExecutionProcess(db, first.execution!.id, { status: 'succeeded' })
    updateStatus(db, task.id, 'blocked', {
      waitingOn: { kind: 'person', need: 'The key', by: 'agent' },
    })
    expect(
      saveAgentCommentWake(
        db,
        task.id,
        addComment(db, task.id, 'here is the key', 'agent', TEAMMATE, { kind: 'agent' }),
      ),
    ).toMatchObject({ state: 'saved' })
    setTeamAlwaysAllow(db, TEAM, true)
    const caughtUp = (): void => {
      const seq = taskReadStates(db, LOCAL_READER).get(task.id)?.activity?.seq ?? 0
      markTaskRead(db, LOCAL_READER, task.id, seq)
      expect(unreadFor(LOCAL_READER, task.id)).toBe(false)
    }
    caughtUp()

    pumpTaskWakes(db, deps())

    expect(getTask(db, task.id)?.status).toBe('todo')
    expect(readAgentWakeGate(db, task.id)?.windowCount).toBe(1)
    expect(unreadFor(LOCAL_READER, task.id)).toBe(true)

    // The claim of the run it starts is news too: a teammate's wake belongs to no person.
    caughtUp()
    expect(claimTask(db, task.id, WORKER, 'hermes', { run: { executorType: 'openclaw' } }).ok).toBe(
      true,
    )
    expect(unreadFor(LOCAL_READER, task.id)).toBe(true)
  })

  it('reads as theirs when a pause lifts and the run starts, and not before', () => {
    const task = blockedTask()
    placePause(db, { kind: 'agent', id: WORKER })
    reply(task.id, LOCAL_READER)

    pumpTaskWakes(db, deps())
    expect(getTask(db, task.id)?.status).toBe('blocked')
    expect(started).toEqual([])
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)

    liftPause(db, 'agent', WORKER)
    pumpTaskWakes(db, deps())
    expect(getTask(db, task.id)?.status).toBe('in_progress')
    expect(started).toEqual([task.id])
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)

    addComment(db, task.id, 'found it', 'agent', WORKER, { kind: 'agent' })
    expect(unreadFor(LOCAL_READER, task.id)).toBe(true)
  })

  it('reads as theirs when the comment names the built-in person, as a Reopen’s does', () => {
    const task = blockedTask()
    const written = runOwnWrite(db, LOCAL_READER, task.id, () =>
      addComment(db, task.id, 'try again', 'user', null, {
        kind: 'person',
        person: { ...LOCAL_PERSON },
      }),
    )
    recordTaskWake(db, {
      teamId: TEAM,
      agentId: WORKER,
      taskId: task.id,
      reason: 'reopened',
      commentIds: [written.id],
    })

    pumpTaskWakes(db, deps())

    expect(getTask(db, task.id)?.status).toBe('in_progress')
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)
  })

  it('falls back to the built-in reader for a wake that carries no comment', () => {
    const task = blockedTask()
    runOwnWrite(db, LOCAL_READER, task.id, () =>
      addComment(db, task.id, 'Reopened.', 'user', null, { kind: 'note' }),
    )
    recordTaskWake(db, { teamId: TEAM, agentId: WORKER, taskId: task.id, reason: 'reopened' })

    pumpTaskWakes(db, deps())

    expect(getTask(db, task.id)?.status).toBe('in_progress')
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)
  })

  it('marks nothing when the move is refused', () => {
    const task = blockedTask()
    reply(task.id, LOCAL_READER)
    pumpTaskWakes(db, deps({ budgetRefuses: () => true }))
    expect(getTask(db, task.id)?.status).toBe('blocked')
    expect(unreadFor(LOCAL_READER, task.id)).toBe(false)
  })
})
