// POST /api/team-chat/exchange stops on a client disconnect, and only then. The
// REAL handler runs behind a real HTTP server with the server's JSON body parser,
// because the bug only shows on a real socket: once the parser has read the body,
// Node emits the request's own 'close', and a handler listening there aborted
// every exchange after its first turn. The engine is stubbed with three timed
// turns that stop when the signal aborts.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const nodeOs = await import('node:os')
  const nodePath = await import('node:path')
  const home = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'clawboo-tcabort-'))
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = nodePath.join(home, '.clawboo')
})

const engine = vi.hoisted(() => ({
  turnsRun: 0,
  abortedAtTurn: null as number | null,
  started: null as null | (() => void),
  finished: null as null | (() => void),
}))

vi.mock('../../lib/teamChat/runTeamExchange', () => ({
  runTeamExchange: vi.fn(async (input: { signal?: AbortSignal }) => {
    engine.started?.()
    let endedReason = 'max_turns'
    for (let turn = 1; turn <= 3; turn++) {
      await new Promise((r) => setTimeout(r, 60))
      engine.turnsRun = turn
      if (input.signal?.aborted) {
        engine.abortedAtTurn = turn
        endedReason = 'aborted'
        break
      }
    }
    engine.finished?.()
    return {
      ok: true,
      roomId: 'team:tm-abort',
      result: { turnsTaken: engine.turnsRun, endedReason, speakers: [] },
    }
  }),
}))

import { releaseRoom, tryAcquireRoom } from '../../lib/teamChat/roomLock'
import { resetDb } from '../../lib/db'
import { teamChatExchangePOST } from '../teamChat'

let server: http.Server | null = null
let port = 0

beforeAll(async () => {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.post('/api/team-chat/exchange', teamChatExchangePOST)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server!.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  resetDb()
})

beforeEach(() => {
  engine.turnsRun = 0
  engine.abortedAtTurn = null
  engine.started = null
  engine.finished = null
})

function post(body: unknown): { req: http.ClientRequest; response: Promise<unknown> } {
  let req!: http.ClientRequest
  const response = new Promise<unknown>((resolve, reject) => {
    req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/team-chat/exchange',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let text = ''
        res.on('data', (c: Buffer) => (text += c.toString()))
        res.on('end', () => resolve(JSON.parse(text)))
      },
    )
    req.on('error', reject)
  })
  req.end(JSON.stringify(body))
  return { req, response }
}

describe('POST /api/team-chat/exchange: aborting on disconnect', () => {
  it('runs every turn while the client is still waiting for the answer', async () => {
    const { response } = post({ teamId: 'tm-abort' })
    const body = (await response) as { ok: boolean; result: { turnsTaken: number } }
    expect(body.ok).toBe(true)
    expect(engine.abortedAtTurn).toBeNull()
    expect(body.result.turnsTaken).toBe(3)
  })

  it('stops between turns once the client disconnects, and frees the room', async () => {
    const started = new Promise<void>((r) => (engine.started = r))
    const finished = new Promise<void>((r) => (engine.finished = r))
    const { req, response } = post({ teamId: 'tm-abort' })
    response.catch(() => undefined) // the destroyed socket rejects it
    await started
    req.destroy()
    await finished
    expect(engine.abortedAtTurn).toBe(1)
    expect(engine.turnsRun).toBe(1)
    // The finally block released the room lock, so the next exchange can start.
    await vi.waitFor(() => {
      expect(tryAcquireRoom('team:tm-abort')).toBe(true)
    })
    releaseRoom('team:tm-abort')
  })
})
