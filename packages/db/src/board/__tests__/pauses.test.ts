// A durable, scoped pause: an agent, a team or a task tree. The row is what every
// start path reads, so it survives a restart and needs no renewal.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LOCAL_PERSON } from '@clawboo/board-core'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { appendEvent } from '../../events'
import { listRoutineFires } from '../../routines/history'
import {
  listQueuedRuns,
  minNextRunAt,
  queueDueRuns,
  requeuePausedFire,
} from '../../routines/repository'
import { agents, scheduledRuns, tasks, teams } from '../../schema'
import {
  isTeamArchived,
  listPauses,
  liftPause,
  pauseFor,
  pauseForTask,
  placePause,
  startRefusedBy,
} from '../pauses'
import {
  assignTaskToPerson,
  claimTask,
  createTask,
  getTask,
  listRoomsWithFireableDelegations,
} from '../repository'
import { setTaskRunnerInputs } from '../runnerInputs'

let dir: string
let file: string
let db: ClawbooDb

function seedTeam(id: string, isArchived = 0): void {
  const now = Date.now()
  db.insert(teams)
    .values({ id, name: id, icon: 'x', color: 'x', isArchived, createdAt: now, updatedAt: now })
    .run()
}

function seedAgent(id: string, teamId: string | null): void {
  const now = Date.now()
  db.insert(agents)
    .values({ id, name: id, gatewayId: id, teamId, createdAt: now, updatedAt: now })
    .run()
}

function boundTask(title: string, agentId: string, teamId = 'T', parentTaskId?: string) {
  return createTask(db, {
    title,
    teamId,
    sourceDelegationId: `plan:${title}:agent:${agentId}`,
    ...(parentTaskId ? { parentTaskId } : {}),
  })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-pauses-'))
  file = path.join(dir, 'test.db')
  db = createDb(file)
  seedTeam('T')
  seedTeam('U')
  seedAgent('a1', 'T')
  seedAgent('a2', 'T')
  seedAgent('b1', 'U')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('placing and lifting a pause', () => {
  it('survives reopening the database, with no renewal', () => {
    placePause(db, { kind: 'agent', id: 'a1', reason: 'checking its work' })
    const reopened = createDb(file)
    const pause = pauseFor(reopened, { agentId: 'a1' })
    expect(pause?.kind).toBe('agent')
    expect(pause?.reason).toBe('checking its work')
  })

  it('records who paused it', () => {
    placePause(db, {
      kind: 'team',
      id: 'T',
      person: { id: 'p1', name: 'Sam', role: null },
    })
    expect(listPauses(db)[0]?.pausedBy).toEqual({ id: 'p1', name: 'Sam', role: null })
  })

  it('keeps the first pause when asked again, and says nothing new happened', () => {
    const first = placePause(db, { kind: 'agent', id: 'a1', reason: 'first' })
    const second = placePause(db, { kind: 'agent', id: 'a1', reason: 'second' })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.pause.reason).toBe('first')
    expect(listPauses(db)).toHaveLength(1)
  })

  it('lifts only the pause named', () => {
    placePause(db, { kind: 'agent', id: 'a1' })
    placePause(db, { kind: 'team', id: 'T' })
    expect(liftPause(db, 'agent', 'a1')).toBe(true)
    expect(liftPause(db, 'agent', 'a1')).toBe(false)
    expect(pauseFor(db, { agentId: 'a1', teamId: 'U' })).toBeNull()
    expect(pauseFor(db, { agentId: 'a1', teamId: 'T' })?.kind).toBe('team')
  })
})

describe('what a pause covers', () => {
  it('covers an agent in every team it runs in', () => {
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(pauseFor(db, { agentId: 'a1', teamId: 'T' })).not.toBeNull()
    expect(pauseFor(db, { agentId: 'a1', teamId: 'U' })).not.toBeNull()
    expect(pauseFor(db, { agentId: 'a2', teamId: 'T' })).toBeNull()
  })

  it('covers every run of a team, and no other team', () => {
    placePause(db, { kind: 'team', id: 'T' })
    expect(pauseFor(db, { agentId: 'a2', teamId: 'T' })).not.toBeNull()
    expect(pauseFor(db, { agentId: 'b1', teamId: 'U' })).toBeNull()
  })

  it("counts a run with no team named under its agent's own team", () => {
    placePause(db, { kind: 'team', id: 'T' })
    expect(pauseFor(db, { agentId: 'a1' })?.kind).toBe('team')
    expect(pauseFor(db, { agentId: 'b1' })).toBeNull()
    // Named, the run's team decides: Boo Zero working for another team is not paused.
    expect(pauseFor(db, { agentId: 'a1', teamId: 'U' })).toBeNull()
  })

  it('covers a whole task tree from its root, including a sub-task made after the pause', () => {
    const root = boundTask('root', 'a1')
    const child = boundTask('child', 'a2', 'T', root.id)
    const other = boundTask('other', 'a2')
    placePause(db, { kind: 'task_tree', id: root.id })
    const late = boundTask('late', 'a2', 'T', child.id)
    expect(pauseFor(db, { taskId: root.id })?.kind).toBe('task_tree')
    expect(pauseFor(db, { taskId: child.id })?.id).toBe(root.id)
    expect(pauseFor(db, { taskId: late.id })?.id).toBe(root.id)
    expect(pauseFor(db, { taskId: other.id })).toBeNull()
  })

  it('reads a task by the agent it is bound to, before anyone claimed it', () => {
    const task = boundTask('bound', 'a1')
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(pauseForTask(db, getTask(db, task.id)!)?.id).toBe('a1')
  })

  it('reads a task the runner ran by the agent it was run for, when nothing else names one', () => {
    const task = createTask(db, { title: 'direct run', teamId: 'U' })
    setTaskRunnerInputs(db, task.id, {
      runtime: 'claude-code',
      assigneeAgentId: 'a1',
      repoPath: null,
      kind: null,
      model: null,
    })
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(pauseForTask(db, getTask(db, task.id)!)?.id).toBe('a1')
  })

  it('stays silent for a subject with nothing named', () => {
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(pauseFor(db, {})).toBeNull()
  })
})

describe('the claim', () => {
  it("tells a claim on a person's task that it is theirs, not that it is paused", () => {
    const task = createTask(db, { title: 'theirs', teamId: 'T' })
    expect(assignTaskToPerson(db, task.id, LOCAL_PERSON).ok).toBe(true)
    placePause(db, { kind: 'team', id: 'T' })
    expect(claimTask(db, task.id, 'a1')).toEqual({ ok: false, reason: 'person_assigned' })
  })

  it('is refused for a paused agent, team or tree, and the task stays in To do', () => {
    const task = createTask(db, { title: 'work', teamId: 'T' })
    for (const [kind, id] of [
      ['agent', 'a1'],
      ['team', 'T'],
      ['task_tree', task.id],
    ] as const) {
      placePause(db, { kind, id })
      expect(claimTask(db, task.id, 'a1')).toEqual({ ok: false, reason: 'paused' })
      expect(getTask(db, task.id)?.status).toBe('todo')
      liftPause(db, kind, id)
    }
    expect(claimTask(db, task.id, 'a1').ok).toBe(true)
  })

  it('is refused for a task on an archived team', () => {
    seedTeam('old', 1)
    const task = createTask(db, { title: 'left behind', teamId: 'old' })
    expect(claimTask(db, task.id, 'a1').reason).toBe('paused')
  })
})

describe('the pump scan', () => {
  it('does not name a room whose only fireable work is paused, so no engine is rebuilt for it', () => {
    boundTask('a job', 'a1')
    expect(listRoomsWithFireableDelegations(db)).toEqual([{ teamId: 'T', roomId: null }])
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(listRoomsWithFireableDelegations(db)).toEqual([])
    liftPause(db, 'agent', 'a1')
    expect(listRoomsWithFireableDelegations(db)).toEqual([{ teamId: 'T', roomId: null }])
  })

  it('still names the room when other work there can run', () => {
    boundTask('paused one', 'a1')
    boundTask('free one', 'a2')
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(listRoomsWithFireableDelegations(db)).toEqual([{ teamId: 'T', roomId: null }])
  })

  it('does not wake an archived team', () => {
    seedTeam('old', 1)
    boundTask('left behind', 'a1', 'old')
    expect(listRoomsWithFireableDelegations(db)).toEqual([])
    expect(isTeamArchived(db, 'old')).toBe(true)
    expect(isTeamArchived(db, 'T')).toBe(false)
  })
})

describe('startRefusedBy, the one check a wake scan calls', () => {
  it('reads a pause, or an archived team as a pause nobody can lift from here', () => {
    seedTeam('old', 1)
    expect(startRefusedBy(db, { agentId: 'a1', teamId: 'T' })).toBeNull()
    expect(startRefusedBy(db, { agentId: 'a1', teamId: 'old' })).toEqual({
      kind: 'archived_team',
      id: 'old',
    })
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(startRefusedBy(db, { agentId: 'a1', teamId: 'T' })).toMatchObject({
      kind: 'agent',
      id: 'a1',
    })
  })
})

describe('a routine fire a pause stopped', () => {
  const NOW = 1_800_000_000_000

  function firing(id: string, cronSpec = '0 9 * * *'): void {
    db.insert(scheduledRuns)
      .values({
        id,
        agentId: 'a1',
        teamId: 'T',
        cronSpec,
        taskTemplate: '{}',
        scheduledBy: 'person',
        status: 'running',
        nextRunAt: NOW - 1_000,
        failureStreak: 1,
        lastError: 'before',
        createdAt: NOW - 10_000,
        updatedAt: NOW - 10_000,
      })
      .run()
  }

  it('goes back to waiting as it was: no last run, no failure, the same next run', () => {
    firing('r1', 'once@1800000000000')
    expect(requeuePausedFire(db, 'r1', NOW)).toBe(true)
    expect(db.select().from(scheduledRuns).where(eq(scheduledRuns.id, 'r1')).get()).toMatchObject({
      status: 'queued',
      lastRunAt: null,
      lastError: 'before',
      failureStreak: 1,
      nextRunAt: NOW - 1_000,
      cronSpec: 'once@1800000000000',
    })
  })

  it('does nothing to a row that has moved on', () => {
    firing('r1')
    db.update(scheduledRuns).set({ status: 'idle' }).where(eq(scheduledRuns.id, 'r1')).run()
    expect(requeuePausedFire(db, 'r1', NOW)).toBe(false)
    expect(db.select().from(scheduledRuns).where(eq(scheduledRuns.id, 'r1')).get()?.status).toBe(
      'idle',
    )
  })

  it('reads as paused in the history, with why, never as run or failed', () => {
    const event = (kind: string, data: object): void => {
      appendEvent(db, { kind, data: { scheduledRunId: 'r1', ...data } } as never)
    }
    event('routine_fired', { cronSpec: 'x', scheduledBy: 'person' })
    event('routine_paused', { taskId: 'task-1', message: 'This agent is paused.' })
    const [fire] = listRoutineFires(db, 'r1')
    expect(fire).toMatchObject({
      status: 'paused',
      error: 'This agent is paused.',
      taskId: 'task-1',
    })
  })
})

describe('routines under a pause', () => {
  const NOW = 1_800_000_000_000

  function seedRoutine(id: string, agentId: string, teamId: string, status = 'idle'): void {
    db.insert(scheduledRuns)
      .values({
        id,
        agentId,
        teamId,
        cronSpec: '0 9 * * *',
        taskTemplate: '{}',
        scheduledBy: 'person',
        status,
        nextRunAt: NOW - 1_000,
        createdAt: NOW - 10_000,
        updatedAt: NOW - 10_000,
      })
      .run()
  }

  it("leaves a paused agent's due routine due, and out of the earliest-next read", () => {
    seedRoutine('r1', 'a1', 'T')
    placePause(db, { kind: 'agent', id: 'a1' })
    // Counted here it would arm the ticker at a delay of 0, forever.
    expect(minNextRunAt(db)).toBeNull()
    expect(queueDueRuns(db, NOW)).toEqual([])
    liftPause(db, 'agent', 'a1')
    expect(minNextRunAt(db)).toBe(NOW - 1_000)
    expect(queueDueRuns(db, NOW).map((r) => r.id)).toEqual(['r1'])
  })

  it("leaves a paused team's routine due, whether it names the team or only an agent in it", () => {
    seedRoutine('r1', '', 'T')
    seedRoutine('r2', 'a1', '')
    db.update(scheduledRuns).set({ teamId: null }).where(eq(scheduledRuns.id, 'r2')).run()
    placePause(db, { kind: 'team', id: 'T' })
    expect(queueDueRuns(db, NOW)).toEqual([])
  })

  it('keeps a queued fire of a paused agent out of the claim list until it resumes', () => {
    seedRoutine('r1', 'a1', 'T', 'queued')
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(listQueuedRuns(db)).toEqual([])
    liftPause(db, 'agent', 'a1')
    expect(listQueuedRuns(db).map((r) => r.id)).toEqual(['r1'])
  })

  it('does not fire a routine on an archived team', () => {
    seedTeam('old', 1)
    seedRoutine('r1', 'a1', 'old')
    expect(queueDueRuns(db, NOW)).toEqual([])
    expect(minNextRunAt(db)).toBeNull()
  })

  it('keeps a task a routine would touch where it is', () => {
    const task = createTask(db, { title: 'work', teamId: 'T' })
    db.update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, task.id)).run()
    placePause(db, { kind: 'task_tree', id: task.id })
    expect(getTask(db, task.id)?.status).toBe('blocked')
  })
})
