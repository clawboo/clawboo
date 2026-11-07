// Pressing Stop against the real orchestrator, through the real route: a task the
// engine releases is not news to the person who pressed. `board.inboxStop.test.ts`
// covers the edges with a stand-in engine; this holds the assumption they rest on,
// that the release lands by the time Stop resolves, as a status move to To do.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  boardActivityHead,
  createTask,
  getTask,
  LOCAL_READER,
  markAllTasksRead,
  teams,
  unreadTasks,
} from '@clawboo/db'
import type { Request, Response } from 'express'

// Every slot is taken: the delivery waits in the queue and settles at once, so the
// task is claimed and running as far as the engine knows, and no runtime ever starts.
vi.mock('../serverDeliver', () => ({
  createServerDeliver: (deps: { queuedRuns: Map<string, { cancel(): void }> }) => {
    return async (sessionKey: string) => {
      deps.queuedRuns.set(sessionKey, { cancel: () => deps.queuedRuns.delete(sessionKey) })
    }
  },
}))

const { getDb, getDbPath, resetDb } = await import('../../db')
const { getTeamOrchestrator, resetTeamOrchestrators } = await import('../teamOrchestrator')
const { teamChatStopPOST } = await import('../../../api/teams')

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

describe('Stop with the real engine', () => {
  let home: string
  let prev: Record<string, string | undefined>

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-stop-own-write-'))
    prev = { HOME: process.env['HOME'], CLAWBOO_HOME: process.env['CLAWBOO_HOME'] }
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'Team T', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        runtime: 'claude-code',
        teamId: 'T',
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
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  async function runningTask(): Promise<string> {
    const db = getDb()
    const orchestrator = getTeamOrchestrator('T')
    await orchestrator.pump()
    const task = createTask(db, {
      title: 'write the report',
      status: 'todo',
      teamId: 'T',
      sourceDelegationId: encodeHumanAssignment('lead', 'n1'),
    })
    expect(await orchestrator.dispatchTask(task.id)).toBe('started')
    expect(getTask(db, task.id)?.status).toBe('in_progress')
    markAllTasksRead(db, LOCAL_READER, boardActivityHead(db))
    expect(unreadTasks(db, LOCAL_READER)).toEqual([])
    return task.id
  }

  async function pressStop(headers: Record<string, string>): Promise<void> {
    let status = 200
    teamChatStopPOST(
      { params: { id: 'T' }, body: {}, query: {}, headers } as unknown as Request,
      {
        status(c: number) {
          status = c
          return this
        },
        json() {
          return this
        },
      } as unknown as Response,
    )
    expect(status).toBe(200)
  }

  it('releases the task, and it is not unread for the person who pressed', async () => {
    const id = await runningTask()
    await pressStop(DASHBOARD)
    await vi.waitFor(() => expect(getTask(getDb(), id)?.status).toBe('todo'))
    await new Promise((r) => setTimeout(r, 20))
    expect(unreadTasks(getDb(), LOCAL_READER)).toEqual([])
  })

  it('is unread when anything but the dashboard’s page pressed it', async () => {
    const id = await runningTask()
    await pressStop({})
    await vi.waitFor(() => expect(getTask(getDb(), id)?.status).toBe('todo'))
    expect(unreadTasks(getDb(), LOCAL_READER).map((t) => t.id)).toEqual([id])
  })
})
