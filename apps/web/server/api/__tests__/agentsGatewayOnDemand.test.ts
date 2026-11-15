// The agents REST surface while nothing uses the OpenClaw Gateway (the server
// connects to it on demand), and the requests that count as a need: opening
// OpenClaw's views (POST /api/agents/registry/connect), asking for an OpenClaw
// agent or a sync, and the browser opening the Gateway proxy.
//
// Each test imports a fresh module graph: the registry is a process singleton
// and "in use" is sticky by design, so one test marking it would leak into the
// next. The registry is never started, so nothing here dials a Gateway, and
// HOME + CLAWBOO_HOME are a throwaway directory.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, status: () => code, body: () => payload }
}
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, headers: DASHBOARD, ...over }) as unknown as Request

async function load() {
  vi.resetModules()
  const api = await import('../agents')
  const db = await import('../../lib/db')
  const registry = await import('../../lib/agentSource')
  expect(db.getDbPath().startsWith(home)).toBe(true)
  return { api, db, registry }
}

let home: string
let prevHome: string | undefined
let prevStateDir: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agents-ondemand-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  prevHome = process.env['HOME']
  prevStateDir = process.env['OPENCLAW_STATE_DIR']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  process.env['OPENCLAW_STATE_DIR'] = path.join(home, '.openclaw')
})
afterEach(async () => {
  const db = await import('../../lib/db')
  db.resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevStateDir === undefined) delete process.env['OPENCLAW_STATE_DIR']
  else process.env['OPENCLAW_STATE_DIR'] = prevStateDir
  delete process.env['CLAWBOO_HOME']
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

/** OpenClaw set up on this machine: its own config exists. */
async function setUpOpenClaw(): Promise<void> {
  await mkdir(path.join(home, '.openclaw'), { recursive: true })
  await writeFile(path.join(home, '.openclaw', 'openclaw.json'), '{}')
}

describe('agents REST while nothing uses the Gateway', () => {
  it('GET /api/agents is not stale, and the registry health says not in use', async () => {
    const { api } = await load()

    const list = mockRes()
    await api.agentsListGET(req(), list.res)
    expect(list.status()).toBe(200)
    expect(list.body()).toMatchObject({ agents: [], stale: false })

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toEqual({
      ok: false,
      connection: 'disconnected',
      lastSyncedAt: null,
      inUse: false,
      configured: false,
      message: 'not in use',
    })
  })

  it('a native agent alone is not a need', async () => {
    const { api } = await load()
    const created = mockRes()
    await api.agentsCreatePOST(
      req({ body: { name: 'Native Boo', sourceId: 'clawboo-native' } }),
      created.res,
    )
    expect(created.status()).toBe(201)

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toMatchObject({ inUse: false })
  })

  it('POST /api/agents/registry/connect marks the Gateway in use; the list is then stale until it connects', async () => {
    const { api } = await load()

    const connect = mockRes()
    await api.agentsRegistryConnectPOST(req(), connect.res)
    expect(connect.status()).toBe(200)
    // Not started in this test, so nothing connects: in use and disconnected,
    // which is what "unreachable" looks like, and no longer "not in use".
    expect(connect.body()).toMatchObject({ inUse: true, connection: 'disconnected' })
    expect(connect.body()).not.toHaveProperty('message')

    const list = mockRes()
    await api.agentsListGET(req(), list.res)
    expect(list.body()).toMatchObject({ stale: true })
  })

  it('asking for an OpenClaw agent is a need when a Gateway is set up', async () => {
    await setUpOpenClaw()
    const { api } = await load()
    const created = mockRes()
    await api.agentsCreatePOST(req({ body: { name: 'Gateway Boo' } }), created.res)
    // Not started in this test, so nothing connects: still 503.
    expect(created.status()).toBe(503)

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toMatchObject({ inUse: true })
  })

  it('asking for an OpenClaw agent with no Gateway set up is not a need', async () => {
    // Otherwise one stray create would have the server retry the default
    // address for the rest of its life, and report OpenClaw stale.
    const { api } = await load()
    const created = mockRes()
    await api.agentsCreatePOST(req({ body: { name: 'Gateway Boo' } }), created.res)
    expect(created.status()).toBe(503)

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toMatchObject({ inUse: false })
  })

  it('a server-side sync asked for is a need when a Gateway is set up', async () => {
    await setUpOpenClaw()
    const { api } = await load()
    const sync = mockRes()
    await api.agentsSyncPOST(req({ body: undefined }), sync.res)
    expect(sync.status()).toBe(503)

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toMatchObject({ inUse: true })
  })

  it('an OpenClaw create on a Gateway already in use does not wait for it', async () => {
    // In use and down: the source is already retrying, so the create answers 503
    // at once rather than waiting out the few seconds a first connect gets.
    await setUpOpenClaw()
    const { api, registry } = await load()
    registry.getRegistry().source.markInUse('a person opened OpenClaw')
    const wait = vi.spyOn(registry.getRegistry().source, 'markInUseAndWait')
    const created = mockRes()
    await api.agentsCreatePOST(req({ body: { name: 'Gateway Boo' } }), created.res)
    expect(created.status()).toBe(503)
    expect(wait).not.toHaveBeenCalled()
  })

  it('a delete owed to an OpenClaw that is no longer set up is not a need', async () => {
    const { api, db } = await load()
    const { setSetting } = await import('@clawboo/db')
    setSetting(db.getDb(), 'agent-source:openclaw:pendingDelete:main', 'main')

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toMatchObject({ inUse: false })
  })

  it('a delete owed to the Gateway is a need, like an OpenClaw agent', async () => {
    // The last OpenClaw agent deleted while the Gateway was down leaves no row,
    // only the delete still owed. Without a connection it would never be sent.
    await setUpOpenClaw()
    const { api, db } = await load()
    const { setSetting } = await import('@clawboo/db')
    setSetting(db.getDb(), 'agent-source:openclaw:pendingDelete:main', 'main')

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toMatchObject({ inUse: true })
  })

  it('the browser opening the Gateway proxy is a need', async () => {
    const { api, registry } = await load()
    const upstream = registry.gatewayProxyUpstreamSettings()
    expect(typeof upstream.url).toBe('string')

    const health = mockRes()
    await api.agentsRegistryHealthGET(req(), health.res)
    expect(health.body()).toMatchObject({ inUse: true })
  })
})
