// Deleting a team while it has work on the board. Everything it was doing stops, its
// open requests close, and nothing brings it back: no engine is built for what it left
// behind, no wake starts a task of it, and its folder stays gone. In its own file because
// `vi.mock` is file-global: the deliver here behaves like a delivery waiting for a slot.

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  addComment,
  agents,
  createHandOffUnderRequest,
  createTask,
  getScheduledRun,
  getTask,
  listExecutions,
  listRoomsWithFireableDelegations,
  recordTaskWake,
  registerScheduledRun,
  setTaskRunnerInputs,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import type { Request, Response } from 'express'

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

const queued = vi.hoisted(() => ({
  cancelled: [] as string[],
}))

vi.mock('../../lib/teamChat/serverDeliver', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/teamChat/serverDeliver')>()
  return {
    ...real,
    createServerDeliver: (deps: {
      queuedRuns: Map<string, { cancel(): void; taskId?: string | null }>
      taskForSession: (sessionKey: string) => string | null
    }) => {
      return async (sessionKey: string) => {
        deps.queuedRuns.set(sessionKey, {
          taskId: deps.taskForSession(sessionKey),
          cancel: () => {
            queued.cancelled.push(sessionKey)
            deps.queuedRuns.delete(sessionKey)
          },
        })
      }
    },
  }
})

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { teamWorkdirPath } = await import('../../lib/runtimes/teamWorkdir')
const { engineRefusal, startRefusal } = await import('../../lib/teamChat/roomRoster')
const { pumpTaskWakeNow, pumpTaskWakes } = await import('../../lib/teamChat/taskWakes')
const { getTeamOrchestrator, hasTeamOrchestrator, resetTeamOrchestrators, roomCanRun } =
  await import('../../lib/teamChat/teamOrchestrator')
const { dispatchRoutine } = await import('../../lib/routines/wakeBridge')
const { teamsDELETE } = await import('../teams')

const TEAM = 'T'
const leadSession = 'agent:lead:team:T'

function fakeRes(): { res: Response; status: () => number } {
  let status = 200
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  return { res, status: () => status }
}

const del = async (): Promise<void> => {
  const r = fakeRes()
  await teamsDELETE(
    { params: { id: TEAM }, body: {}, query: {}, headers: DASHBOARD } as never as Request,
    r.res,
  )
  expect(r.status()).toBe(200)
}

describe('deleting a team with work going', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-team-delete-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetDb()
    expect(getDbPath().startsWith(home)).toBe(true)
    queued.cancelled = []
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team T',
        icon: 'x',
        color: '#000',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        runtime: 'claude-code',
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  const assigned = (title = 'write the report') =>
    createTask(db, {
      title,
      status: 'todo',
      teamId: TEAM,
      sourceDelegationId: encodeHumanAssignment('lead', 'n1'),
    })

  it('stops its engine and its runs, and the task is left stopped', async () => {
    const orchestrator = getTeamOrchestrator(TEAM)
    await orchestrator.pump()
    const task = assigned()
    expect(await orchestrator.dispatchTask(task.id)).toBe('started')

    await del()

    expect(queued.cancelled).toEqual([leadSession])
    expect(hasTeamOrchestrator(TEAM)).toBe(false)
    expect(listExecutions(db, task.id).at(-1)?.status).toBe('cancelled')
    expect(getTask(db, task.id)?.status).toBe('todo')
  })

  it('closes its open requests and the work under them, saying why', async () => {
    const made = createHandOffUnderRequest(
      db,
      {
        title: 'Build it',
        description: 'Build it',
        leadAgentId: 'lead',
        key: `main:${TEAM}:d1`,
      },
      {
        title: 'part',
        teamId: TEAM,
        sourceDelegationId: 'd1:deleg:agent:lead:reflectTo:lead',
        agentCreated: true,
        titleMatchNeedsOwner: true,
      },
    )
    if (!made.ok) throw new Error(made.reason)

    await del()

    const mainId = made.task.parentTaskId as string
    expect(getTask(db, mainId)?.status).toBe('cancelled')
    expect(getTask(db, made.task.id)?.status).toBe('cancelled')
  })

  it('no pump finds it again: nothing lists it, and no room of it can run', async () => {
    const left = assigned()
    expect(listRoomsWithFireableDelegations(db)).toEqual([{ teamId: TEAM, roomId: null }])
    expect(roomCanRun(db, TEAM, null)).toBe(true)

    await del()

    expect(listRoomsWithFireableDelegations(db)).toEqual([])
    expect(roomCanRun(db, TEAM, null)).toBe(false)
    expect(engineRefusal(db, getTask(db, left.id)!)).toBe('no_team')
    expect(startRefusal(db, getTask(db, left.id)!, true)).toBe('no_team')
    expect(hasTeamOrchestrator(TEAM)).toBe(false)
  })

  describe('its routines', () => {
    const routine = (agentId: string, template: Record<string, unknown>): string => {
      const made = registerScheduledRun(db, {
        agentId,
        teamId: TEAM,
        cronSpec: '0 9 * * *',
        taskTemplate: JSON.stringify({
          title: 'Chore',
          kind: 'research',
          priority: 1,
          ...template,
        }),
        nextRunAt: 1_000,
        tenantId: null,
      })
      if (!made.ok) throw new Error(made.reason)
      return made.run.id
    }

    it('an agent routine stays with its agent, and files its task with no team', async () => {
      const id = routine('lead', {})
      await del()
      const run = getScheduledRun(db, id)!
      expect(run.teamId).toBeNull()
      expect(run.status).toBe('idle')

      const started: string[] = []
      const outcome = await dispatchRoutine(run, {
        db,
        mcpBaseUrl: null,
        runTask: async (input) => {
          started.push(input.taskId)
          return {
            ok: true,
            runtimeId: 'claude-code',
            execId: 'e1',
            doneReason: 'success',
            status: 'done',
            summary: 'ok',
            costUsd: null,
            usedWorktree: false,
            degradations: [],
          }
        },
      })
      expect(outcome.ok).toBe(true)
      expect(getTask(db, started[0]!)?.teamId).toBeNull()
      await expect(stat(teamWorkdirPath(TEAM))).rejects.toThrow()
    })

    it('a team routine keeps the team, and says it no longer exists', async () => {
      const id = routine('', { target: 'team', description: 'Summarize.' })
      await del()
      const run = getScheduledRun(db, id)!
      expect(run.teamId).toBe(TEAM)
      await expect(dispatchRoutine(run, { db, mcpBaseUrl: null })).resolves.toMatchObject({
        ok: false,
        error: 'The team this routine posts to no longer exists.',
      })
    })

    it('another team’s routines stay as they are', async () => {
      const now = Date.now()
      db.insert(teams)
        .values({
          id: 'OTHER',
          name: 'O',
          icon: 'x',
          color: '#000',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      const made = registerScheduledRun(db, {
        agentId: 'lead',
        teamId: 'OTHER',
        cronSpec: '0 9 * * *',
        taskTemplate: JSON.stringify({ title: 'Chore', kind: 'research', priority: 1 }),
        nextRunAt: 1_000,
        tenantId: null,
      })
      if (!made.ok) throw new Error(made.reason)
      await del()
      expect(getScheduledRun(db, made.run.id)?.teamId).toBe('OTHER')
    })
  })

  it('a wake on a task it left behind starts nothing, and its folder stays gone', async () => {
    const left = assigned('on the engine')
    const onRunner = assigned('on the runner')
    setTaskRunnerInputs(db, onRunner.id, {
      runtime: 'claude-code',
      assigneeAgentId: 'lead',
      repoPath: null,
      kind: null,
      model: null,
    })
    await mkdir(teamWorkdirPath(TEAM), { recursive: true })

    await del()

    for (const task of [left, onRunner]) {
      const comment = addComment(db, task.id, 'still there?', 'user', null, { kind: 'person' })
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: 'lead',
        taskId: task.id,
        reason: 'person_comment',
        commentIds: [comment.id],
      })
    }
    const startForPerson = vi.fn()
    const pumpRoom = vi.fn()
    const deps = {
      held: () => false,
      startForPerson,
      startByItself: startForPerson,
      pumpRoom,
      alert: () => true,
    }
    // A person's own action reads the wake on the spot, before any reap.
    expect(pumpTaskWakeNow(db, onRunner.id, deps)).toEqual({ do: 'wait', skip: 'no_team' })
    expect(pumpTaskWakeNow(db, left.id, deps)).toEqual({ do: 'wait', skip: 'no_team' })
    pumpTaskWakes(db, deps)

    expect(startForPerson).not.toHaveBeenCalled()
    expect(pumpRoom).not.toHaveBeenCalled()
    await expect(stat(teamWorkdirPath(TEAM))).rejects.toThrow()
  })
})
