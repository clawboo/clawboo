// An archived chat room's unfinished tasks move to the team's own chat, stopped.
//
// Archiving a room only stamped the room. Its tasks kept their room, and the only
// engine left to run them (the team's own chat, room null) reads tasks with no
// room, so Retry, Assign and a reply on them all answered success while nothing
// ever ran. Moving them is not enough on its own: a ready task bound to an agent
// would then be started by the team chat's pump at once, so archiving would START
// queued work. Each one is marked stopped first, the same marker a person's Stop
// writes, so it waits in Needs you for a Retry.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ledgerAllowsAutoFire } from '@clawboo/board-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { agents, teams } from '../../schema'
import {
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getReadyTasks,
  getTask,
  linkDep,
  listExecutions,
  reconcileOrphans,
  updateStatus,
} from '../repository'
import { archiveRoom, createRoom, moveArchivedRoomTasks } from '../rooms'

let dir: string
let db: ClawbooDb
let roomId: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-archived-room-'))
  db = createDb(path.join(dir, 'test.db'))
  const now = Date.now()
  db.insert(teams)
    .values({ id: 'T', name: 'T', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
    .run()
  for (const id of ['bea', 'cy'])
    db.insert(agents)
      .values({ id, name: id, gatewayId: id, teamId: 'T', createdAt: now, updatedAt: now })
      .run()
  roomId = createRoom(db, { teamId: 'T', name: 'Design', memberIds: ['bea', 'cy'] }).id
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A task in the room, bound to `agent` the way the engine binds a delegation. */
function roomTask(title: string, agent = 'bea', status: 'todo' | 'backlog' = 'todo'): string {
  return createTask(db, {
    title,
    teamId: 'T',
    roomId,
    status,
    sourceDelegationId: `run-1:deleg:agent:${agent}:reflectTo:lead`,
  }).id
}

const lastRun = (taskId: string): string | undefined => listExecutions(db, taskId).at(-1)?.status

describe('moveArchivedRoomTasks', () => {
  it("moves an archived room's unfinished tasks to the team's own chat", () => {
    const queued = roomTask('Queued')
    const blocked = roomTask('Blocked')
    claimTask(db, blocked, 'bea')
    updateStatus(db, blocked, 'blocked')
    archiveRoom(db, roomId)

    const { moved } = moveArchivedRoomTasks(db)
    expect(moved.map((t) => t.id).sort()).toEqual([queued, blocked].sort())
    expect(getTask(db, queued)?.roomId).toBeNull()
    expect(getTask(db, blocked)?.roomId).toBeNull()
    expect(getTask(db, blocked)?.status).toBe('blocked')
  })

  it('marks a ready task bound to an agent stopped, so the team chat does not start it', () => {
    const queued = roomTask('Queued')
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db)
    expect(lastRun(queued)).toBe('cancelled')
    // It is in the team chat's ready list now, and the pump's policy holds it.
    expect(getReadyTasks(db, { teamId: 'T', roomId: null }).map((t) => t.id)).toEqual([queued])
    expect(ledgerAllowsAutoFire(listExecutions(db, queued))).toBe(false)
  })

  it('leaves a waiting plan step unmarked, so it runs once the step before it is done', () => {
    const first = roomTask('Step 1')
    const second = roomTask('Step 2', 'cy')
    linkDep(db, second, first)
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db)
    expect(getTask(db, second)?.roomId).toBeNull()
    expect(listExecutions(db, second)).toEqual([])
  })

  it('starts that waiting step once the step before it is retried and done', () => {
    const first = roomTask('Step 1')
    const second = roomTask('Step 2', 'cy')
    linkDep(db, second, first)
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db)
    claimTask(db, first, 'bea')
    updateStatus(db, first, 'done')
    expect(getReadyTasks(db, { teamId: 'T', roomId: null }).map((t) => t.id)).toEqual([second])
    expect(ledgerAllowsAutoFire(listExecutions(db, second))).toBe(true)
  })

  it('marks a step stopped that waits on a task outside the room', () => {
    // That task finishes in its own chat with no retry here, and the step would
    // then start in the team chat with nobody asking for it.
    const elsewhere = createTask(db, { title: 'In General', teamId: 'T' }).id
    const step = roomTask('Waits on General')
    linkDep(db, step, elsewhere)
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db)
    expect(lastRun(step)).toBe('cancelled')
    claimTask(db, elsewhere, 'cy')
    updateStatus(db, elsewhere, 'done')
    expect(getReadyTasks(db, { teamId: 'T', roomId: null }).map((t) => t.id)).toContain(step)
    expect(ledgerAllowsAutoFire(listExecutions(db, step))).toBe(false)
  })

  it('does not mark a task stopped again when its Stop already did', () => {
    const queued = roomTask('Queued')
    const stop = createExecutionProcess(db, { taskId: queued, executorType: 'openclaw' })
    completeExecutionProcess(db, stop.id, { status: 'cancelled' })
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db)
    moveArchivedRoomTasks(db)
    expect(listExecutions(db, queued)).toHaveLength(1)
  })

  it('leaves finished tasks where they were', () => {
    const done = roomTask('Done')
    claimTask(db, done, 'bea')
    updateStatus(db, done, 'done')
    const cancelled = roomTask('Cancelled')
    updateStatus(db, cancelled, 'cancelled')
    archiveRoom(db, roomId)
    expect(moveArchivedRoomTasks(db).moved).toEqual([])
    expect(getTask(db, done)?.roomId).toBe(roomId)
    expect(getTask(db, cancelled)?.roomId).toBe(roomId)
  })

  it('leaves the tasks of a room that is still active alone', () => {
    const queued = roomTask('Queued')
    expect(moveArchivedRoomTasks(db).moved).toEqual([])
    expect(getTask(db, queued)?.roomId).toBe(roomId)
    expect(listExecutions(db, queued)).toEqual([])
  })

  it('stops a task still running in the room when no engine stopped it', () => {
    // After a restart a room's engine is built only for ready work, so a step
    // still in progress there has no engine to stop it. Moved while running, the
    // stale sweep would release it and the team chat would start it again.
    const running = roomTask('Running step')
    claimTask(db, running, 'bea')
    createExecutionProcess(db, { taskId: running, executorType: 'openclaw' })
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db)
    expect(getTask(db, running)).toMatchObject({ status: 'todo', roomId: null })
    expect(lastRun(running)).toBe('cancelled')
    expect(ledgerAllowsAutoFire(listExecutions(db, running))).toBe(false)
  })

  it('leaves a run the task runner owns alone, and its task out of the Stop', () => {
    // The task runner reruns its own tasks; a stopped marker would end that.
    const queued = roomTask('Runner task')
    const running = roomTask('Runner run', 'cy')
    claimTask(db, running, 'cy')
    createExecutionProcess(db, { taskId: running, executorType: 'claude-code' })
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db, { skip: (t) => t.id === queued || t.id === running })
    expect(listExecutions(db, queued)).toEqual([])
    expect(getTask(db, queued)?.roomId).toBeNull()
    expect(getTask(db, running)?.status).toBe('in_progress')
    expect(lastRun(running)).toBe('running')
  })

  it('returns the engine runs it closed, so the server can stop them where they run', () => {
    const running = roomTask('Running step')
    claimTask(db, running, 'bea')
    const run = createExecutionProcess(db, { taskId: running, executorType: 'openclaw' })
    roomTask('Queued step', 'cy')
    archiveRoom(db, roomId)
    expect(moveArchivedRoomTasks(db).closedRuns).toEqual([
      { taskId: running, execId: run.id, teamId: 'T', roomId, agentId: 'bea' },
    ])
    // A marker for a queued task stopped nothing that was running, and a second
    // pass closes nothing.
    expect(moveArchivedRoomTasks(db).closedRuns).toEqual([])
  })

  it('returns a run the boot reap closed first: it was never aborted either', () => {
    // The reap runs before the move and takes a run silent past its window, so at
    // boot this is the usual way a crashed server's run reaches the move.
    const running = roomTask('Running step')
    claimTask(db, running, 'bea')
    const run = createExecutionProcess(db, { taskId: running, executorType: 'openclaw' })
    expect(reconcileOrphans(db, { staleAfterMs: -1 }).reconciled).toBe(1)
    archiveRoom(db, roomId)
    expect(moveArchivedRoomTasks(db).closedRuns).toEqual([
      { taskId: running, execId: run.id, teamId: 'T', roomId, agentId: 'bea' },
    ])
    expect(getTask(db, running)).toMatchObject({ status: 'todo', roomId: null })
    // Marked stopped as any ready task is, and listed only once.
    expect(lastRun(running)).toBe('cancelled')
    expect(moveArchivedRoomTasks(db).closedRuns).toEqual([])
  })

  it('returns no crashed run of the task runner, and no run that reported', () => {
    const runner = roomTask('Runner run')
    claimTask(db, runner, 'bea')
    createExecutionProcess(db, { taskId: runner, executorType: 'claude-code' })
    reconcileOrphans(db, { staleAfterMs: -1 })
    const finished = roomTask('Finished run', 'cy')
    claimTask(db, finished, 'cy')
    const run = createExecutionProcess(db, { taskId: finished, executorType: 'openclaw' })
    completeExecutionProcess(db, run.id, { status: 'failed', error: 'it said why' })
    updateStatus(db, finished, 'todo')
    archiveRoom(db, roomId)
    expect(moveArchivedRoomTasks(db).closedRuns).toEqual([])
  })

  it('returns no run it did not close', () => {
    const skipped = roomTask('Skipped')
    claimTask(db, skipped, 'bea')
    createExecutionProcess(db, { taskId: skipped, executorType: 'openclaw' })
    const runner = roomTask('Runner run', 'cy')
    claimTask(db, runner, 'cy')
    createExecutionProcess(db, { taskId: runner, executorType: 'claude-code' })
    archiveRoom(db, roomId)
    const { closedRuns } = moveArchivedRoomTasks(db, { skip: (t) => t.id === skipped })
    expect(closedRuns).toEqual([])
    expect(lastRun(skipped)).toBe('running')
  })

  it("leaves a run that is not the engine's alone, even when nothing skips it", () => {
    const running = roomTask('Runner run')
    claimTask(db, running, 'bea')
    createExecutionProcess(db, { taskId: running, executorType: 'claude-code' })
    archiveRoom(db, roomId)
    moveArchivedRoomTasks(db)
    expect(getTask(db, running)?.status).toBe('in_progress')
    expect(lastRun(running)).toBe('running')
  })

  it('moves only the room it is given', () => {
    const mine = roomTask('Mine')
    const otherRoom = createRoom(db, { teamId: 'T', name: 'Other', memberIds: ['cy'] }).id
    const theirs = createTask(db, { title: 'Theirs', teamId: 'T', roomId: otherRoom }).id
    archiveRoom(db, roomId)
    archiveRoom(db, otherRoom)
    expect(moveArchivedRoomTasks(db, { roomId }).moved.map((t) => t.id)).toEqual([mine])
    expect(getTask(db, theirs)?.roomId).toBe(otherRoom)
  })
})
