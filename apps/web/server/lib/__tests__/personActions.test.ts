// Which requests count as a person acting: a person-action route from any client,
// or a write the identity lane names a person on; never a read, never a vouched
// request by itself, never an automatic write, never a runtime's MCP call.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import express, { type Request } from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPresence, type Presence } from '../presence'
import { AUTOMATIC_WRITE_ROUTES, PERSON_ACTION_ROUTES, recordPersonActions } from '../personActions'

let server: http.Server
let base: string
let record: Presence

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  // Stands in for the identity lane: the header names a person, as a verified token would.
  app.use((req, _res, next) => {
    if (req.headers['x-test-person']) {
      ;(req as Request).person = { id: String(req.headers['x-test-person']) } as Request['person']
    }
    next()
  })
  app.use(recordPersonActions(() => record))
  const ok = (_req: Request, res: express.Response): void => {
    res.json({ ok: true })
  }
  app.post('/api/board/:taskId/comments', ok)
  app.get('/api/board', ok)
  app.post('/api/board/:taskId/read', ok)
  app.post('/api/system/presence', ok)
  app.post('/api/system/hold', ok)
  app.put('/api/teams/:id/labels', ok)
  app.post('/api/mcp/tasks', ok)
  app.post('/api/teams/:id/chat', (_req, res) => {
    res.status(409).json({ error: 'busy' })
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  record = createPresence()
})

async function send(method: string, path: string, person?: string): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(person ? { 'x-test-person': person } : {}),
    },
    ...(method === 'GET' ? {} : { body: '{}' }),
  })
  await res.text()
  // `finish` fires as the response is handed off; let it run.
  await new Promise((resolve) => setImmediate(resolve))
}

describe('person actions', () => {
  it('a comment counts from any client, with no one vouching for it', async () => {
    await send('POST', '/api/board/t1/comments')
    expect(record.state().present).toBe(true)
  })

  it('a person action counts even when the server refused it', async () => {
    await send('POST', '/api/teams/t1/chat')
    expect(record.state().present).toBe(true)
  })

  it('a read never counts, even one a proxy vouched for', async () => {
    await send('GET', '/api/board', 'person-1')
    expect(record.state().present).toBe(false)
  })

  it('another write counts only when the identity lane names a person on it', async () => {
    await send('PUT', '/api/teams/t1/labels')
    expect(record.state().present).toBe(false)
    await send('PUT', '/api/teams/t1/labels', 'person-1')
    expect(record.state().present).toBe(true)
  })

  it('automatic writes never count, vouched or not', async () => {
    await send('POST', '/api/board/t1/read', 'person-1')
    await send('POST', '/api/system/presence', 'person-1')
    await send('POST', '/api/system/hold', 'person-1')
    expect(record.state().present).toBe(false)
  })

  it("a runtime's MCP call never counts", async () => {
    await send('POST', '/api/mcp/tasks', 'person-1')
    expect(record.state().present).toBe(false)
  })

  it('a request no route served never counts', async () => {
    await send('POST', '/api/nothing-here', 'person-1')
    expect(record.state().present).toBe(false)
  })

  it('every listed route is one the server serves', async () => {
    const { apiRouter } = await import('../../api/index')
    const served = new Set<string>()
    for (const layer of (
      apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>
      }
    ).stack) {
      if (!layer.route) continue
      for (const method of Object.keys(layer.route.methods)) {
        served.add(`${method.toUpperCase()} ${layer.route.path}`)
      }
    }
    expect([...PERSON_ACTION_ROUTES].filter((r) => !served.has(r))).toEqual([])
    expect([...AUTOMATIC_WRITE_ROUTES].filter((r) => !served.has(r))).toEqual([])
    // A route is one or the other, never both.
    expect([...PERSON_ACTION_ROUTES].filter((r) => AUTOMATIC_WRITE_ROUTES.has(r))).toEqual([])
  })
})
