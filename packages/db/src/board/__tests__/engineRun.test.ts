// Which runs are the team engine's own. Every engine run is labelled `openclaw`, and the
// executions route takes any name, so the marker says and the label does not. A row from
// before the marker has only the label, and then only the engine wrote it.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { agents, executionProcesses, tasks, teams } from '../../schema'
import { onBoardLifecycle, resetBoardLifecycleListeners } from '../events'
import {
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getTask,
  listExecutions,
  listRoomsWithEngineTasksInReview,
  reconcileOrphans,
  updateStatus,
} from '../repository'
import { archiveRoom, createRoom, moveArchivedRoomTasks } from '../rooms'

type Shape = 'engine' | 'engine, truly named' | 'old row' | 'reported'

/** Opens a run in one of the shapes a ledger holds. */
function openRun(db: ClawbooDb, taskId: string, shape: Shape): string {
  const exec = createExecutionProcess(db, {
    taskId,
    executorType: shape === 'engine, truly named' ? 'hermes' : 'openclaw',
    ...(shape === 'engine' || shape === 'engine, truly named' ? { engineRun: true } : {}),
  })
  if (shape === 'old row')
    db.update(executionProcesses)
      .set({ engineRun: null })
      .where(eq(executionProcesses.id, exec.id))
      .run()
  return exec.id
}

const ENGINE_SHAPES: Shape[] = ['engine', 'engine, truly named', 'old row']

describe('the engine marker on a run', () => {
  let dir: string
  let db: ClawbooDb
  let roomId: string

  const inProgress = (title: string): string => {
    const t = createTask(db, {
      title,
      teamId: 'T',
      roomId,
      sourceDelegationId: 'run-1:deleg:agent:bea:reflectTo:lead',
    })
    claimTask(db, t.id, 'bea')
    return t.id
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-engine-run-'))
    db = createDb(path.join(dir, 'test.db'))
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: 'bea',
        name: 'Bea',
        gatewayId: 'bea',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    roomId = createRoom(db, { teamId: 'T', name: 'Design', memberIds: ['bea'] }).id
  })

  afterEach(() => {
    resetBoardLifecycleListeners()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is written only when a writer says it is the engine', () => {
    const plain = createTask(db, { title: 'plain', teamId: 'T' })
    expect(
      createExecutionProcess(db, { taskId: plain.id, executorType: 'openclaw' }).engineRun,
    ).toBe(0)
    expect(
      createExecutionProcess(db, { taskId: plain.id, executorType: 'openclaw', engineRun: true })
        .engineRun,
    ).toBe(1)

    const claimed = createTask(db, { title: 'claimed', teamId: 'T' })
    const byEngine = claimTask(db, claimed.id, 'bea', 'openclaw', {
      run: { executorType: 'openclaw', engineRun: true },
    })
    expect(byEngine.execution?.engineRun).toBe(1)
    const other = createTask(db, { title: 'other', teamId: 'T' })
    const byRunner = claimTask(db, other.id, 'bea', 'openclaw', {
      run: { executorType: 'openclaw' },
    })
    expect(byRunner.execution?.engineRun).toBe(0)
  })

  describe('rooms the pump builds an engine for', () => {
    const inReview = (shape: Shape): void => {
      const id = inProgress(shape)
      openRun(db, id, shape)
      updateStatus(db, id, 'in_review')
    }

    it.each(ENGINE_SHAPES)('lists a task In review under a run of this shape: %s', (shape) => {
      inReview(shape)
      expect(listRoomsWithEngineTasksInReview(db)).toEqual([{ teamId: 'T', roomId }])
    })

    it('leaves out a run someone else labelled openclaw', () => {
      inReview('reported')
      expect(listRoomsWithEngineTasksInReview(db)).toEqual([])
    })
  })

  describe('the boot sweep, which leaves a team-chat check to its engine', () => {
    const swept = (shape: Shape): string | undefined => {
      const id = inProgress(shape)
      const exec = openRun(db, id, shape)
      updateStatus(db, id, 'in_review')
      reconcileOrphans(db, { staleAfterMs: -10_000 })
      return listExecutions(db, id).find((e) => e.id === exec)?.status
    }

    it.each(ENGINE_SHAPES)('leaves a run of this shape open: %s', (shape) => {
      expect(swept(shape)).toBe('running')
    })

    it('reaps a run someone else labelled openclaw', () => {
      expect(swept('reported')).toBe('failed')
    })
  })

  describe('archiving a room', () => {
    it.each(ENGINE_SHAPES)('stops a run of this shape and returns its task: %s', (shape) => {
      const id = inProgress(shape)
      const exec = openRun(db, id, shape)
      archiveRoom(db, roomId)

      const { closedRuns } = moveArchivedRoomTasks(db)

      expect(listExecutions(db, id).find((e) => e.id === exec)?.status).toBe('cancelled')
      expect(getTask(db, id)?.status).toBe('todo')
      expect(closedRuns.map((r) => r.execId)).toEqual([exec])
    })

    it('leaves alone a run someone else labelled openclaw', () => {
      const id = inProgress('reported')
      const exec = openRun(db, id, 'reported')
      archiveRoom(db, roomId)

      const { closedRuns } = moveArchivedRoomTasks(db)

      expect(listExecutions(db, id).find((e) => e.id === exec)?.status).toBe('running')
      expect(getTask(db, id)?.status).toBe('in_progress')
      expect(closedRuns).toEqual([])
    })

    it('names only the engine’s crashed run for a Gateway abort', () => {
      const crashed = (shape: Shape): { id: string; exec: string } => {
        const id = inProgress(shape)
        const exec = openRun(db, id, shape)
        completeExecutionProcess(db, exec, { status: 'failed', error: 'orphaned' })
        db.update(executionProcesses)
          .set({ recoveryTombstone: 1, status: 'failed' })
          .where(eq(executionProcesses.id, exec))
          .run()
        db.update(tasks)
          .set({ status: 'todo', assigneeAgentId: null })
          .where(eq(tasks.id, id))
          .run()
        return { id, exec }
      }
      const engine = crashed('engine')
      const old = crashed('old row')
      const reported = crashed('reported')
      archiveRoom(db, roomId)

      const named = moveArchivedRoomTasks(db).closedRuns.map((r) => r.execId)

      expect(named).toEqual(expect.arrayContaining([engine.exec, old.exec]))
      expect(named).not.toContain(reported.exec)
    })

    it('marks the stop it leaves on a task that never started as the engine’s', () => {
      const t = createTask(db, {
        title: 'waiting',
        teamId: 'T',
        roomId,
        sourceDelegationId: 'run-1:deleg:agent:bea:reflectTo:lead',
      })
      archiveRoom(db, roomId)
      moveArchivedRoomTasks(db)
      expect(listExecutions(db, t.id).at(-1)).toMatchObject({ status: 'cancelled', engineRun: 1 })
    })
  })

  it('travels on the run’s completion event', () => {
    const seen: Array<{ execId: string; engineRun: unknown }> = []
    onBoardLifecycle((ev) => {
      if (ev.kind === 'execution_completed')
        seen.push({ execId: ev.execId, engineRun: ev.engineRun })
    })
    const t = createTask(db, { title: 'x', teamId: 'T' })
    const engine = openRun(db, t.id, 'engine')
    completeExecutionProcess(db, engine, { status: 'succeeded' })
    const reported = openRun(db, t.id, 'reported')
    completeExecutionProcess(db, reported, { status: 'succeeded' })
    expect(seen).toEqual([
      { execId: engine, engineRun: 1 },
      { execId: reported, engineRun: 0 },
    ])
  })
})
