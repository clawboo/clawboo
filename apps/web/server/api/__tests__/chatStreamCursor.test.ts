// A chat stream that drops before its first stored row must still resume where it
// started. A browser sends Last-Event-ID only once it has received an id, so each
// chat stream opens with a `cursor` event that carries one. Driven over real HTTP:
// connect fresh, drop, store a row while disconnected, then reconnect the way an
// EventSource does, with the last id it received.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { agents, latestChatMessageId, teams } from '@clawboo/db'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { agentChatSessionKey } from '../../lib/agentChat/driveAgentChat'
import { getDb, resetDb } from '../../lib/db'
import { persistNativeChatEntry } from '../../lib/runtimes/native/nativeDriver'
import { persistTeamChatEntry } from '../../lib/teamChat/persistTeamChatEntry'
import { apiRouter } from '../index'

interface Frame {
  id?: string
  event: string
  data: string
}

/** One SSE block; null for a comment or a block with no data. */
function parseBlock(block: string): Frame | null {
  let id: string | undefined
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4)
    else if (line.startsWith('event: ')) event = line.slice(7)
    else if (line.startsWith('data: ')) data.push(line.slice(6))
  }
  if (data.length === 0) return null
  return { ...(id === undefined ? {} : { id }), event, data: data.join('\n') }
}

/**
 * Open a stream and collect frames until `done` or `waitMs`, then drop the
 * connection. Never throws on the wait running out: the caller asserts on what
 * arrived.
 */
async function read(
  url: string,
  headers: Record<string, string>,
  done: (frames: Frame[]) => boolean,
  waitMs: number,
): Promise<Frame[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  const frames: Frame[] = []
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done: ended } = await reader.read()
      if (ended) break
      buf += decoder.decode(value, { stream: true })
      let cut = buf.indexOf('\n\n')
      while (cut !== -1) {
        const frame = parseBlock(buf.slice(0, cut))
        buf = buf.slice(cut + 2)
        if (frame) frames.push(frame)
        cut = buf.indexOf('\n\n')
      }
      if (done(frames)) break
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  return frames
}

/** The headers an EventSource reconnects with after receiving `frames`: the last
 *  id it saw as Last-Event-ID, or nothing when no frame carried one. */
function reconnectHeaders(frames: Frame[]): Record<string, string> {
  const id = frames.filter((f) => f.id !== undefined).at(-1)?.id
  return id === undefined ? {} : { 'last-event-id': id }
}

/**
 * Connect fresh and drop before any row arrives, store a row while disconnected,
 * then reconnect as a browser would. Returns the first connection's frames and the
 * rows the reconnect delivered.
 */
async function dropAndReconnect(
  url: string,
  storeWhileDown: () => void,
): Promise<{ first: Frame[]; rows: Frame[] }> {
  const first = await read(url, {}, hasCursor, 2_000)
  storeWhileDown()
  const again = await read(url, reconnectHeaders(first), hasRow, 5_000)
  return { first, rows: again.filter((f) => f.event === 'message') }
}

const hasCursor = (frames: Frame[]): boolean => frames.some((f) => f.event === 'cursor')
const hasRow = (frames: Frame[]): boolean => frames.some((f) => f.event === 'message')

let dir: string
let prevHome: string | undefined
let server: http.Server
let base: string

beforeAll(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-chat-cursor-'))
  process.env['CLAWBOO_HOME'] = dir
  const app = express()
  app.set('case sensitive routing', true)
  app.use(express.json())
  app.use(apiRouter)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  rmSync(dir, { recursive: true, force: true })
})

describe('chat streams resume after a drop before the first stored row', () => {
  it('team chat', async () => {
    const db = getDb()
    const teamId = 'cursor-team'
    const agentId = 'cursor-member'
    db.insert(teams)
      .values({ id: teamId, name: teamId, icon: 'x', color: '#fff', createdAt: 0, updatedAt: 0 })
      .run()
    db.insert(agents)
      .values({
        id: agentId,
        name: agentId,
        gatewayId: agentId,
        teamId,
        createdAt: 0,
        updatedAt: 0,
      })
      .run()
    const sessionKey = buildTeamSessionKey(agentId, teamId)
    persistTeamChatEntry(db, { teamId, agentId, text: 'history', role: 'user', kind: 'user' })
    const head = latestChatMessageId(db, [sessionKey])

    const { first, rows } = await dropAndReconnect(`${base}/api/teams/${teamId}/chat/stream`, () =>
      persistTeamChatEntry(db, { teamId, agentId, text: 'missed', role: 'user', kind: 'user' }),
    )

    expect(rows.map((f) => (JSON.parse(f.data) as { text: string }).text)).toEqual(['missed'])
    expect(rows[0]!.id).toBe(String(latestChatMessageId(db, [sessionKey])))
    // A fresh connect starts at the head and says so before anything else.
    expect(first.map((f) => f.event)).toEqual(['cursor'])
    expect(first[0]!.id).toBe(String(head))
    expect(JSON.parse(first[0]!.data)).toEqual({ cursor: head })
  })

  it('1:1 agent chat', async () => {
    const db = getDb()
    const agentId = 'cursor-solo'
    const sessionKey = agentChatSessionKey(db, agentId)
    persistNativeChatEntry(db, agentId, 'history', { sessionKey })
    const head = latestChatMessageId(db, [sessionKey])

    const { first, rows } = await dropAndReconnect(
      `${base}/api/agents/${agentId}/chat/stream`,
      () => persistNativeChatEntry(db, agentId, 'missed', { sessionKey }),
    )

    expect(rows.map((f) => (JSON.parse(f.data) as { text: string }).text)).toEqual(['missed'])
    // Whether this chat hands off is said too, with no id, so it moves no cursor.
    expect(first.map((f) => f.event).filter((e) => e !== 'handOffs')).toEqual(['cursor'])
    expect(first[0]!.id).toBe(String(head))
    expect(first.find((f) => f.event === 'handOffs')?.id).toBeUndefined()
  })

  it('opens a resumed stream with the cursor it was given', async () => {
    const db = getDb()
    const agentId = 'cursor-resume'
    const sessionKey = agentChatSessionKey(db, agentId)
    persistNativeChatEntry(db, agentId, 'one', { sessionKey })
    const one = latestChatMessageId(db, [sessionKey])

    const frames = await read(
      `${base}/api/agents/${agentId}/chat/stream?since=${one}`,
      {},
      hasCursor,
      5_000,
    )
    expect(frames[0]).toMatchObject({ event: 'cursor', id: String(one) })
  })
})
