// GET, POST /api/system/hold and DELETE /api/system/hold/:owner over real HTTP:
// a hold reports the agent runs still going, holds new ones back, refuses a
// release by any other owner id, and checks what it is given.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { engineHoldStateSchema } from '@clawboo/control-client'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { engineHold } from '../../lib/engineHold'
import { createRunSlots, runSlots, setRunSlotsForTests } from '../../lib/runSlots'
import { systemHoldDELETE, systemHoldGET, systemHoldPOST } from '../systemHold'

let server: http.Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.get('/api/system/hold', systemHoldGET)
  app.post('/api/system/hold', systemHoldPOST)
  app.delete('/api/system/hold/:owner', systemHoldDELETE)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
afterEach(() => {
  for (const hold of engineHold().list()) engineHold().release(hold.owner)
  setRunSlotsForTests(null)
})

async function hold(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/system/hold`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function state(): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/system/hold`)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

async function release(owner: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/system/hold/${encodeURIComponent(owner)}`, {
    method: 'DELETE',
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('/api/system/hold', () => {
  it('reports an engine nobody holds, with no run going', async () => {
    setRunSlotsForTests(createRunSlots(3))
    expect(engineHoldStateSchema.parse(await state())).toEqual({
      held: false,
      holds: [],
      backgroundWork: 'none',
      runs: { running: 0, queued: 0, limit: 3 },
    })
  })

  it('holds new runs back and reports the one still going until it finishes', async () => {
    const going = runSlots().tryAcquire()!
    const placed = await hold({ owner: 'clawboo-stop-123', ttlSeconds: 30, reason: 'stop' })
    expect(placed.status).toBe(200)
    const held = engineHoldStateSchema.parse(placed.body)
    expect(held.held).toBe(true)
    expect(held.holds).toHaveLength(1)
    expect(held.holds[0]).toMatchObject({ owner: 'clawboo-stop-123', reason: 'stop' })
    expect(held.holds[0]!.expiresAt - held.holds[0]!.heldAt).toBe(30_000)
    expect(held.holds[0]!.expiresInMs).toBeGreaterThan(29_000)
    expect(held.backgroundWork).toBe('present')
    expect(held.runs.running).toBe(1)

    // No new run starts while held.
    expect(runSlots().tryAcquire()).toBeNull()

    going.release()
    const drained = engineHoldStateSchema.parse(await state())
    expect(drained.backgroundWork).toBe('none')
    expect(drained.held).toBe(true)
  })

  it('refuses a release by another owner id and keeps the engine held', async () => {
    await hold({ owner: 'desktop-updater' })
    const refused = await release('clawboo-stop-999')
    expect(refused.status).toBe(404)
    expect(refused.body['error']).toMatch(/only the owner that placed a hold releases it/i)
    expect(engineHoldStateSchema.parse(await state()).held).toBe(true)

    const released = await release('desktop-updater')
    expect(released.status).toBe(200)
    expect(engineHoldStateSchema.parse(released.body)).toMatchObject({ held: false, holds: [] })
    // Releasing twice is refused the same way, so a script can tell.
    expect((await release('desktop-updater')).status).toBe(404)
  })

  it('renews a hold its owner places again, keeping one hold per owner', async () => {
    await hold({ owner: 'pm', ttlSeconds: 10, reason: 'restart' })
    const renewed = engineHoldStateSchema.parse((await hold({ owner: 'pm', ttlSeconds: 60 })).body)
    expect(renewed.holds).toHaveLength(1)
    expect(renewed.holds[0]!.reason).toBe('restart')
    expect(renewed.holds[0]!.expiresInMs).toBeGreaterThan(59_000)
  })

  it('uses the default time to live when none is named', async () => {
    const placed = engineHoldStateSchema.parse((await hold({ owner: 'plain' })).body)
    expect(placed.holds[0]!.expiresAt - placed.holds[0]!.heldAt).toBe(60_000)
    expect(placed.holds[0]!.reason).toBeNull()
  })

  it.each([
    [{}, /owner/],
    [{ owner: '' }, /owner/],
    [{ owner: '-leading-dash' }, /owner/],
    [{ owner: 'has space' }, /owner/],
    [{ owner: 'x'.repeat(129) }, /owner/],
    [{ owner: 42 }, /owner/],
    [{ owner: 'ok', ttlSeconds: 4 }, /ttlSeconds/],
    [{ owner: 'ok', ttlSeconds: 901 }, /ttlSeconds/],
    [{ owner: 'ok', ttlSeconds: 30.5 }, /ttlSeconds/],
    [{ owner: 'ok', ttlSeconds: '30' }, /ttlSeconds/],
    [{ owner: 'ok', reason: 7 }, /reason/],
    [{ owner: 'ok', reason: 'r'.repeat(201) }, /reason/],
  ])('refuses %j with 400 and places no hold', async (body, message) => {
    const res = await hold(body)
    expect(res.status).toBe(400)
    expect(String(res.body['error'])).toMatch(message)
    expect(engineHold().isHeld()).toBe(false)
  })
})
