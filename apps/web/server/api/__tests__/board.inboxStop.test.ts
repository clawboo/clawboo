// Pressing Stop in a team chat, or archiving a room, is a person's own write. The
// engine does the releasing and knows nothing about who asked, so the route says it
// for them afterwards: the tasks it put back are not news to the person who pressed.
// Anything else that happened meanwhile still is.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  addComment,
  boardActivityHead,
  createRoom,
  createTask,
  LOCAL_READER,
  markAllTasksRead,
  teams,
  unreadTasks,
  updateStatus,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  stop: async (): Promise<void> => {},
  retired: [] as string[],
}))

vi.mock('../../lib/teamChat/teamOrchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/teamChat/teamOrchestrator')>()),
  hasTeamOrchestrator: () => true,
  getTeamOrchestrator: () => ({ stop: () => engine.stop() }),
  retireRoomOrchestrator: async (_teamId: string, roomId: string) => {
    engine.retired.push(roomId)
    await engine.stop()
  },
}))
vi.mock('../../lib/teamChat/resolveServerOrchestrated', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/teamChat/resolveServerOrchestrated')>()),
  resolveServerOrchestrated: () => true,
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { teamChatStopPOST } = await import('../teams')
const { teamRoomDELETE } = await import('../rooms')

const TEAM = 'T'
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

async function call(
  handler: (req: Request, res: Response) => unknown,
  opts: { params?: Record<string, string>; body?: unknown; headers?: Record<string, string> },
): Promise<number> {
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
  await handler(
    {
      params: opts.params ?? {},
      body: opts.body ?? {},
      query: {},
      headers: opts.headers ?? DASHBOARD,
    } as unknown as Request,
    res,
  )
  return status
}

/** Long enough for the un-awaited Stop in the route to land. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
const unreadIds = (): string[] => unreadTasks(getDb(), LOCAL_READER).map((t) => t.id)

/** A task an agent is running, which the person has already read. */
function running(title = 'Write it', roomId?: string): string {
  const db = getDb()
  const task = createTask(db, {
    title,
    teamId: TEAM,
    status: 'todo',
    ...(roomId ? { roomId } : {}),
  })
  expect(updateStatus(db, task.id, 'in_progress').ok).toBe(true)
  return task.id
}
const readAll = (): void => {
  const db = getDb()
  markAllTasksRead(db, LOCAL_READER, boardActivityHead(db))
}

describe('a person’s Stop', () => {
  let home: string
  let prev: Record<string, string | undefined>

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-inbox-stop-'))
    prev = { HOME: process.env['HOME'], CLAWBOO_HOME: process.env['CLAWBOO_HOME'] }
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    engine.retired = []
    engine.stop = async () => {}
    const now = Date.now()
    getDb()
      .insert(teams)
      .values({ id: TEAM, name: 'T', icon: 't', color: '#fff', createdAt: now, updatedAt: now })
      .run()
  })

  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  const release = (...ids: string[]): void => {
    engine.stop = async () => {
      await Promise.resolve()
      for (const id of ids) updateStatus(getDb(), id, 'todo')
    }
  }

  it('does not bring back the tasks it stopped as news', async () => {
    const a = running('A')
    const b = running('B')
    readAll()
    release(a, b)

    expect(await call(teamChatStopPOST, { params: { id: TEAM } })).toBe(200)
    await settle()
    expect(getDb().$client.prepare('SELECT status FROM tasks WHERE id = ?').get(a)).toEqual({
      status: 'todo',
    })
    expect(unreadIds()).toEqual([])
  })

  it('counts as someone else’s from anyone but the dashboard’s page', async () => {
    const a = running()
    readAll()
    release(a)
    await call(teamChatStopPOST, { params: { id: TEAM }, headers: {} })
    await settle()
    expect(unreadIds()).toEqual([a])
  })

  it('leaves a task it did not put back: an agent finishing as Stop lands is news', async () => {
    const stopped = running('Stopped')
    const finished = running('Finished')
    readAll()
    engine.stop = async () => {
      updateStatus(getDb(), finished, 'done')
      updateStatus(getDb(), stopped, 'todo')
    }
    await call(teamChatStopPOST, { params: { id: TEAM } })
    await settle()
    expect(unreadIds()).toEqual([finished])
  })

  it('leaves a comment that lands after the release', async () => {
    const a = running()
    readAll()
    engine.stop = async () => {
      updateStatus(getDb(), a, 'todo')
      addComment(getDb(), a, 'A late result.', 'agent', 'coder')
    }
    await call(teamChatStopPOST, { params: { id: TEAM } })
    await settle()
    expect(unreadIds()).toEqual([a])
  })

  it('leaves work in another room alone', async () => {
    const room = createRoom(getDb(), { teamId: TEAM, name: 'Side', memberIds: [] })
    const here = running('Here')
    const there = running('There', room.id)
    readAll()
    engine.stop = async () => {
      updateStatus(getDb(), here, 'todo')
      updateStatus(getDb(), there, 'todo')
    }
    await call(teamChatStopPOST, { params: { id: TEAM } })
    await settle()
    expect(unreadIds()).toEqual([there])
  })

  it('archiving a room stops its work the same way', async () => {
    const room = createRoom(getDb(), { teamId: TEAM, name: 'Side', memberIds: [] })
    const a = running('In the room', room.id)
    readAll()
    release(a)
    const status = await call(teamRoomDELETE, { params: { id: TEAM, roomId: room.id } })
    expect(status).toBe(200)
    expect(engine.retired).toEqual([room.id])
    expect(unreadIds()).toEqual([])
  })

  it('still answers when the Stop fails', async () => {
    running()
    readAll()
    const failures: unknown[] = []
    const onRejection = (err: unknown): void => void failures.push(err)
    process.on('unhandledRejection', onRejection)
    engine.stop = async () => {
      throw new Error('boom')
    }
    expect(await call(teamChatStopPOST, { params: { id: TEAM } })).toBe(200)
    await settle()
    process.off('unhandledRejection', onRejection)
    expect(failures).toEqual([])
    expect(unreadIds()).toEqual([])
  })
})
