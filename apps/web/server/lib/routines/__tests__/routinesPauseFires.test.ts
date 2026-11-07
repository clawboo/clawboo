// What a pause does to a routine's fires, through the real ticker and the real
// dispatch. A fire a pause holds back or stops did not happen: it reads so in the
// history, it counts as no failure, it does not spend a one-time routine, and it runs
// on resume. The check reads the fire's real target, so a paused lead holds a team's
// routine back, and an @mention in its instructions decides who that is.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  createDb,
  createTask,
  getComments,
  getScheduledRun,
  getTask,
  liftPause,
  listRoutineFires,
  listTasks,
  placePause,
  registerScheduledRun,
  teams,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'

import type { RunTaskResult } from '../../executorRunner'
import { createRoutinesTicker } from '../ticker'
import { dispatchRoutine, routineStartRefusal } from '../wakeBridge'

let dir: string
let db: ClawbooDb

const noopLog = { info: () => {}, warn: () => {}, error: () => {} }
const NOW = 1_800_000_000_000

function seed(): void {
  const now = Date.now()
  db.insert(teams)
    .values({
      id: 'T',
      name: 'Growth',
      icon: 'x',
      color: 'x',
      leaderAgentId: 'lead',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  for (const id of ['lead', 'Ben', 'solo']) {
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: 'clawboo-native',
        runtime: 'clawboo-native',
        teamId: id === 'solo' ? null : 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
}

function register(
  template: Record<string, unknown>,
  over: { agentId?: string; teamId?: string | null; cronSpec?: string } = {},
): DbScheduledRun {
  const result = registerScheduledRun(db, {
    agentId: over.agentId ?? '',
    teamId: over.teamId === undefined ? 'T' : over.teamId,
    cronSpec: over.cronSpec ?? '0 9 * * *',
    taskTemplate: JSON.stringify({
      title: 'Morning sweep',
      kind: 'research',
      priority: 0,
      ...template,
    }),
    nextRunAt: NOW - 1_000,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

const teamRoutine = (description?: string): DbScheduledRun =>
  register({ target: 'team', ...(description ? { description } : {}) })

const STOPPED: RunTaskResult = {
  ok: true,
  runtimeId: 'clawboo-native',
  execId: 'e1',
  doneReason: 'aborted',
  status: 'todo',
  summary: '',
  costUsd: null,
  usedWorktree: false,
  degradations: [],
  stoppedByPerson: true,
  stoppedByPause: true,
}
const SUCCESS: RunTaskResult = {
  ...STOPPED,
  doneReason: 'success',
  stoppedByPause: undefined,
  stoppedByPerson: undefined,
}

/** The real ticker over the real dispatch, recording who was asked to do what. */
function firing(opts: { runTask?: () => Promise<RunTaskResult> } = {}) {
  const posted: string[] = []
  const ran: string[] = []
  const ticker = createRoutinesTicker({
    db,
    log: noopLog,
    now: () => NOW,
    held: () => false,
    dispatch: (run) =>
      dispatchRoutine(run, {
        db,
        mcpBaseUrl: null,
        enqueueTeamMessage: async (_teamId, input) => {
          posted.push(input.stimulus)
          return { ok: true, targetAgentId: 'lead' }
        },
        runTask: async (input) => {
          ran.push(input.taskId)
          return opts.runTask ? opts.runTask() : SUCCESS
        },
      }),
  })
  return { ticker, posted, ran }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-routine-pause-fires-'))
  db = createDb(path.join(dir, 'test.db'))
  seed()
})

afterEach(() => {
  vi.useRealTimers()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a team routine whose lead is paused', () => {
  it('holds the fire: nothing posted, nothing recorded as run, and it runs once on resume', async () => {
    const run = teamRoutine()
    const f = firing()
    placePause(db, { kind: 'agent', id: 'lead' })

    expect((await f.ticker.tick()).fired).toBe(0)
    expect(f.posted).toEqual([])
    const held = getScheduledRun(db, run.id)!
    expect(held.lastRunAt).toBeNull()
    expect(held.failureStreak).toBe(0)
    expect(listRoutineFires(db, run.id)).toEqual([])

    liftPause(db, 'agent', 'lead')
    expect((await f.ticker.tick()).fired).toBe(1)
    expect(f.posted).toHaveLength(1)
    expect(getScheduledRun(db, run.id)?.lastRunAt).toBe(NOW)
  })

  it('does not spend a one-time routine', async () => {
    const run = register({ target: 'team' }, { cronSpec: `once@${NOW - 1_000}` })
    const f = firing()
    placePause(db, { kind: 'agent', id: 'lead' })
    await f.ticker.tick()
    expect(getScheduledRun(db, run.id)?.status).toBe('queued')
    liftPause(db, 'agent', 'lead')
    expect((await f.ticker.tick()).fired).toBe(1)
    expect(f.posted).toHaveLength(1)
  })

  it('does not spin its timer while it holds the fire', async () => {
    vi.useFakeTimers()
    teamRoutine()
    placePause(db, { kind: 'agent', id: 'lead' })
    const f = firing()
    const reads = vi.spyOn(db, 'update')
    f.ticker.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads.mock.calls.length).toBeLessThan(6)
    f.ticker.stop()
  })
})

describe('the real target of a team routine', () => {
  it('fires for a free member the instructions @mention, though the lead is paused', async () => {
    teamRoutine('@Ben sweep the inbox')
    const f = firing()
    placePause(db, { kind: 'agent', id: 'lead' })
    expect((await f.ticker.tick()).fired).toBe(1)
    expect(f.posted).toEqual(['@Ben sweep the inbox'])
  })

  it('holds for a paused member the instructions @mention, though the lead is free', async () => {
    const run = teamRoutine('@Ben sweep the inbox')
    const f = firing()
    placePause(db, { kind: 'agent', id: 'Ben' })
    expect((await f.ticker.tick()).fired).toBe(0)
    expect(f.posted).toEqual([])
    expect(getScheduledRun(db, run.id)?.failureStreak).toBe(0)
  })
})

describe('a routine bound to a task', () => {
  it('holds while the task tree is paused, and does not count a failure', async () => {
    const root = createTask(db, { title: 'root', teamId: 'T' })
    const bound = createTask(db, { title: 'bound', teamId: 'T', parentTaskId: root.id })
    const run = register({ teamTaskId: bound.id }, { agentId: 'lead' })
    const f = firing()
    placePause(db, { kind: 'task_tree', id: root.id })
    expect(routineStartRefusal(db, run)?.kind).toBe('task_tree')
    expect((await f.ticker.tick()).fired).toBe(0)
    expect(f.ran).toEqual([])
    expect(getScheduledRun(db, run.id)?.failureStreak).toBe(0)

    liftPause(db, 'task_tree', root.id)
    expect((await f.ticker.tick()).fired).toBe(1)
    expect(f.ran).toEqual([bound.id])
  })
})

describe('an agent routine a pause stops mid-run', () => {
  it('starts again on resume, reads as paused, and does not spend a one-time routine', async () => {
    const run = register({}, { agentId: 'solo', teamId: null, cronSpec: `once@${NOW - 1_000}` })
    let stopNext = true
    const f = firing({
      runTask: async () => {
        if (!stopNext) return SUCCESS
        stopNext = false
        placePause(db, { kind: 'agent', id: 'solo' })
        return STOPPED
      },
    })

    await f.ticker.tick()
    expect(f.ran).toHaveLength(1)
    const stopped = getScheduledRun(db, run.id)!
    expect(stopped.status).toBe('queued')
    expect(stopped.lastRunAt).toBeNull()
    expect(stopped.failureStreak).toBe(0)
    expect(stopped.lastError).toBeNull()
    expect(listRoutineFires(db, run.id)[0]?.status).toBe('paused')

    // Its card says what happens, and does not sit in Needs you as unassigned.
    const firstTask = f.ran[0]!
    expect(getTask(db, firstTask)?.status).toBe('cancelled')
    expect(getComments(db, firstTask).at(-1)?.body).toContain('runs again on resume')

    // Held while the pause lasts.
    expect((await f.ticker.tick()).fired).toBe(0)
    expect(f.ran).toHaveLength(1)

    liftPause(db, 'agent', 'solo')
    expect((await f.ticker.tick()).fired).toBe(1)
    expect(f.ran).toHaveLength(2)
    expect(f.ran[1]).not.toBe(firstTask)
    expect(getTask(db, f.ran[1]!)?.status).not.toBe('cancelled')
    expect(listRoutineFires(db, run.id)[0]?.status).toBe('succeeded')
    expect(listTasks(db, {}).filter((t) => t.status === 'todo')).toHaveLength(1)
  })

  it('leaves a task bound at registration as it was, and runs that one again', async () => {
    const bound = createTask(db, { title: 'bound', teamId: 'T' })
    register({ teamTaskId: bound.id }, { agentId: 'lead' })
    let stopNext = true
    const f = firing({
      runTask: async () => {
        if (!stopNext) return SUCCESS
        stopNext = false
        placePause(db, { kind: 'agent', id: 'lead' })
        return STOPPED
      },
    })
    await f.ticker.tick()
    expect(getTask(db, bound.id)?.status).toBe('todo')
    liftPause(db, 'agent', 'lead')
    await f.ticker.tick()
    expect(f.ran).toEqual([bound.id, bound.id])
  })

  it('treats a run the runner refused for a pause the same way', async () => {
    const run = register({}, { agentId: 'solo', teamId: null })
    let refuse = true
    const f = firing({
      runTask: async () => {
        if (!refuse) return SUCCESS
        refuse = false
        placePause(db, { kind: 'agent', id: 'solo' })
        return { ok: false, reason: 'paused' }
      },
    })
    await f.ticker.tick()
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'queued', failureStreak: 0 })
    expect(getTask(db, f.ran[0]!)?.status).toBe('cancelled')
  })

  it('an OpenClaw fire a pause stopped goes the same way', async () => {
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'oc',
        name: 'oc',
        gatewayId: 'oc',
        sourceId: 'openclaw',
        runtime: 'openclaw',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const run = register({}, { agentId: 'oc', teamId: null })
    const started: string[] = []
    const ticker = createRoutinesTicker({
      db,
      log: noopLog,
      now: () => NOW,
      held: () => false,
      dispatch: (r) =>
        dispatchRoutine(r, {
          db,
          mcpBaseUrl: null,
          getOperatorClient: () =>
            ({ call: async () => ({}), onEvent: () => () => undefined }) as never,
          dispatchConnected: async ({ taskId }) => {
            started.push(taskId)
            if (started.length > 1) return { ok: true, taskId }
            placePause(db, { kind: 'agent', id: 'oc' })
            return { ok: false, taskId, error: 'Stopped: this agent is paused.', paused: true }
          },
        }),
    })

    await ticker.tick()
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'queued', failureStreak: 0 })
    expect(listRoutineFires(db, run.id)[0]?.status).toBe('paused')
    expect(getTask(db, started[0]!)?.status).toBe('cancelled')

    expect((await ticker.tick()).fired).toBe(0)
    liftPause(db, 'agent', 'oc')
    expect((await ticker.tick()).fired).toBe(1)
    expect(started).toHaveLength(2)
    expect(started[1]).not.toBe(started[0])
    expect(listRoutineFires(db, run.id)[0]?.status).toBe('succeeded')
  })
})
