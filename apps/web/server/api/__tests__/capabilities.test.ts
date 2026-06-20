// Capabilities REST handlers against the REAL multiplexer + a sandbox CLAWBOO_HOME
// (fresh DB per test). Covers the manageability gate end-to-end: GET 200 merged,
// install spec-validation 400, install target-agent 404 (no invisible orphan +
// false ok), install onto a live agent ok, enable/disable observe-only 422 +
// unknown-id 404, approve validation 400/404, and the unknown-action 400.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createDb, getCapability, upsertCapabilities } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildRecord } from '../../lib/capabilitySource/helpers'
import { recordToInsert, rowToRecord } from '../../lib/capabilitySource/mapper'
import { getDbPath } from '../../lib/db'
import { capabilitiesActionPOST, capabilitiesListGET } from '../capabilities'

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
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

const installSpec = (over: Record<string, unknown> = {}) => ({
  spec: {
    via: 'native',
    agentId: 'a1',
    runtime: 'clawboo-native',
    kind: 'skill',
    name: 'My Skill',
    ...over,
  },
})

describe('capabilities REST', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-capabilities-rest-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    const db = createDb(getDbPath())
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'a1',
        name: 'A1',
        gatewayId: 'a1',
        runtime: 'clawboo-native',
        sourceId: 'clawboo-native',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('GET returns 200 with the merged records + per-source status', async () => {
    const r = mockRes()
    await capabilitiesListGET(req(), r.res)
    expect(r.status()).toBe(200)
    const body = r.body() as { records: unknown[]; sources: unknown[] }
    expect(Array.isArray(body.records)).toBe(true)
    expect(body.records.length).toBeGreaterThan(0) // the native builtin tools at minimum
    expect(Array.isArray(body.sources)).toBe(true)
  })

  it('install with a malformed spec is 400', async () => {
    const r = mockRes()
    await capabilitiesActionPOST(
      req({ params: { action: 'install' }, body: { spec: { via: 'native' } } }),
      r.res,
    )
    expect(r.status()).toBe(400)
  })

  it('install onto an UNKNOWN agent is 404 (target validation — no invisible orphan)', async () => {
    const r = mockRes()
    await capabilitiesActionPOST(
      req({ params: { action: 'install' }, body: installSpec({ agentId: 'ghost' }) }),
      r.res,
    )
    expect(r.status()).toBe(404)
  })

  it('install onto a LIVE agent succeeds', async () => {
    const r = mockRes()
    await capabilitiesActionPOST(req({ params: { action: 'install' }, body: installSpec() }), r.res)
    expect(r.status()).toBe(200)
    expect((r.body() as { ok: boolean }).ok).toBe(true)
  })

  it('enable/disable on an observe-only capability is 422', async () => {
    const db = createDb(getDbPath())
    const rec = buildRecord({
      sourceId: 'hermes',
      runtime: 'hermes',
      scope: 'agent',
      agentId: 'a1',
      kind: 'skill',
      sourceKey: 'web-fetch',
      origin: 'filesystem-skill-md',
      manageability: 'observe-only',
      name: 'Web Fetch',
      available: true,
      status: 'ready',
    })
    upsertCapabilities(db, 'hermes', [recordToInsert(rec)])
    const r = mockRes()
    await capabilitiesActionPOST(
      req({ params: { action: 'disable' }, body: { id: rec.id } }),
      r.res,
    )
    expect(r.status()).toBe(422)
  })

  it('enable/disable on an unknown id is 404', async () => {
    const r = mockRes()
    await capabilitiesActionPOST(
      req({ params: { action: 'disable' }, body: { id: 'native:nope' } }),
      r.res,
    )
    expect(r.status()).toBe(404)
  })

  function seedOpenClawConnector(db: ReturnType<typeof createDb>): ReturnType<typeof buildRecord> {
    const rec = buildRecord({
      sourceId: 'openclaw',
      runtime: 'openclaw',
      scope: 'global',
      kind: 'connector',
      sourceKey: 'mcp:vendor-server',
      origin: 'openclaw-extension',
      manageability: 'runtime-of-record',
      name: 'Vendor MCP',
      available: true,
      status: 'ready',
      writable: false,
    })
    upsertCapabilities(db, 'openclaw', [recordToInsert(rec)])
    return rec
  }

  it('rowToRecord re-derives writable:false for a runtime-of-record OpenClaw extension (degraded last-good DB keeps the gate)', () => {
    const db = createDb(getDbPath())
    const rec = seedOpenClawConnector(db)
    // The column does NOT persist `writable`; reading the row back + mapping must
    // RE-DERIVE writable:false so the dashboard's dead-button gate survives a
    // disconnected (last-good DB) OpenClaw source. A managed native tool stays actionable.
    expect(rowToRecord(getCapability(db, rec.id)!).writable).toBe(false)
    const native = buildRecord({
      sourceId: 'native',
      runtime: 'clawboo-native',
      scope: 'agent',
      agentId: 'a1',
      kind: 'tool',
      sourceKey: 'echo',
      origin: 'brokered-mcp',
      manageability: 'managed',
      name: 'echo',
      available: true,
      status: 'ready',
    })
    upsertCapabilities(db, 'native', [recordToInsert(native)])
    expect(rowToRecord(getCapability(db, native.id)!).writable).not.toBe(false)
  })

  it('disable on a non-writable runtime-of-record connector is 422 at the REST gate (before any adapter write)', async () => {
    const db = createDb(getDbPath())
    const rec = seedOpenClawConnector(db)
    const r = mockRes()
    await capabilitiesActionPOST(
      req({ params: { action: 'disable' }, body: { id: rec.id } }),
      r.res,
    )
    expect(r.status()).toBe(422)
    // The REST gate is authoritative — it derives `writable` from the row and
    // blocks BEFORE delegating to the adapter's write() throw (the body carries
    // writable:false; the observe-only/adapter-throw paths never do).
    expect((r.body() as { writable?: boolean }).writable).toBe(false)
  })

  it('install resolves the runtime from the agent row (the record reflects the agent, not the placeholder spec.runtime)', async () => {
    const r = mockRes()
    // The client hardcodes runtime:'openclaw' (installSkill), but a1 is a clawboo-native agent.
    await capabilitiesActionPOST(
      req({ params: { action: 'install' }, body: installSpec({ runtime: 'openclaw' }) }),
      r.res,
    )
    expect(r.status()).toBe(200)
    expect((r.body() as { record: { runtime: string } }).record.runtime).toBe('clawboo-native')
  })

  it('approve requires { id, decision } → 400', async () => {
    const r = mockRes()
    await capabilitiesActionPOST(req({ params: { action: 'approve' }, body: { id: 'x' } }), r.res)
    expect(r.status()).toBe(400)
  })

  it('approve on an unknown id is 404', async () => {
    const r = mockRes()
    await capabilitiesActionPOST(
      req({ params: { action: 'approve' }, body: { id: 'nope', decision: 'allow_once' } }),
      r.res,
    )
    expect(r.status()).toBe(404)
  })

  it('an unknown action is 400', async () => {
    const r = mockRes()
    await capabilitiesActionPOST(req({ params: { action: 'frobnicate' }, body: {} }), r.res)
    expect(r.status()).toBe(400)
  })
})
