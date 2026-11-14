// GET /api/system/idle and POST /api/system/presence over real HTTP, against a
// sandboxed home: only a presence beat makes a person present (reading never
// does), the work section matches the hold route, and the next due time comes from
// the engine's routines with an OpenClaw Gateway that is not set up reading as off.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { engineIdleStateSchema } from '@clawboo/control-client'
import { registerScheduledRun } from '@clawboo/db'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { createPresence, setPresenceForTests } from '../../lib/presence'
import { resetScheduleMultiplexer } from '../../lib/scheduleSource/registry'
import { systemIdleGET, systemPresencePOST } from '../systemIdle'

let server: http.Server
let base: string
let home: string
const saved = {
  HOME: process.env['HOME'],
  CLAWBOO_HOME: process.env['CLAWBOO_HOME'],
  OPENCLAW_STATE_DIR: process.env['OPENCLAW_STATE_DIR'],
}

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.get('/api/system/idle', systemIdleGET)
  app.post('/api/system/presence', systemPresencePOST)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-idle-route-'))
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  // No OpenClaw set up here, whatever the machine running the tests has.
  process.env['OPENCLAW_STATE_DIR'] = path.join(home, '.openclaw')
  expect(getDbPath().startsWith(home)).toBe(true)
  setPresenceForTests(createPresence())
  resetScheduleMultiplexer()
})
afterEach(() => {
  setPresenceForTests(null)
  resetScheduleMultiplexer()
  // Close the database before its folder goes: Windows refuses to delete an open file.
  resetDb()
  for (const key of ['HOME', 'CLAWBOO_HOME', 'OPENCLAW_STATE_DIR'] as const) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(home, { recursive: true, force: true })
})

async function idle() {
  const res = await fetch(`${base}/api/system/idle`)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  const body: unknown = await res.json()
  const parsed = engineIdleStateSchema.safeParse(body)
  expect(parsed.success).toBe(true)
  return parsed.data!
}

async function beat(body: unknown) {
  const res = await fetch(`${base}/api/system/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('/api/system/idle', () => {
  it('reading it, however often, never makes a person present', async () => {
    for (let i = 0; i < 5; i++) await idle()
    expect((await idle()).people).toEqual({
      present: false,
      lastSeenAt: null,
      lastActedAt: null,
      focusedTabs: 0,
    })
  })

  it('a visible, focused beat makes a person present; a hidden one ends it', async () => {
    expect((await beat({ tabId: 'tab-1', visible: true, focused: true })).status).toBe(200)
    expect((await idle()).people).toMatchObject({ present: true, focusedTabs: 1 })
    await beat({ tabId: 'tab-1', visible: false, focused: false })
    expect((await idle()).people).toMatchObject({ present: false, focusedTabs: 0 })
  })

  it('refuses a beat it cannot read', async () => {
    expect((await beat({ visible: true, focused: true })).status).toBe(400)
    expect((await beat({ tabId: 'bad id!', visible: true, focused: true })).status).toBe(400)
    expect((await beat({ tabId: 'x'.repeat(65), visible: true, focused: true })).status).toBe(400)
    expect((await beat({ tabId: 'tab-1', visible: 'yes', focused: true })).status).toBe(400)
    expect((await beat({ tabId: 'tab-1', visible: true, focused: true, acted: 1 })).status).toBe(
      400,
    )
    expect((await idle()).people.present).toBe(false)
  })

  it('reports no work going on an idle engine', async () => {
    expect((await idle()).work).toMatchObject({
      backgroundWork: 'none',
      checks: 0,
      routinesInFlight: 0,
      held: false,
    })
  })

  it('names the next routine, with no Gateway set up reading as off rather than unknown', async () => {
    const next = Date.now() + 3_600_000
    const result = registerScheduledRun(getDb(), {
      agentId: 'agent-1',
      teamId: null,
      cronSpec: '0 9 * * *',
      taskTemplate: JSON.stringify({ title: 'Daily', kind: 'research', priority: 0 }),
      nextRunAt: next,
    })
    expect(result.ok).toBe(true)
    const { nextDue } = await idle()
    expect(nextDue.at).toBe(next)
    expect(nextDue.complete).toBe(true)
    expect(nextDue.sources).toEqual([
      { id: 'clawboo-routine', state: 'ok', at: next, count: 1, timeZone: nextDue.timeZone },
      {
        id: 'openclaw-gateway-cron',
        state: 'off',
        at: null,
        count: 0,
        timeZone: null,
        reason: 'not_configured',
      },
      // No Hermes agents and no Clawboo-installed Hermes: off, not unknown.
      {
        id: 'hermes-gateway-jobs',
        state: 'off',
        at: null,
        count: 0,
        timeZone: null,
        reason: 'not_configured',
      },
    ])
  })
})
