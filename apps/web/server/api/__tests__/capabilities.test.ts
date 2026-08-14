// Capabilities REST handlers against the REAL multiplexer + a sandbox CLAWBOO_HOME
// (fresh DB per test). Covers the manageability gate end-to-end: GET 200 merged,
// install spec-validation 400, install target-agent 404 (no invisible orphan +
// false ok), install onto a live agent ok, enable/disable observe-only 422 +
// unknown-id 404, approve validation 400/404, and the unknown-action 400. Also pins
// the writable derivation's TOOL carve-out (#146): a Gateway tools.allow/deny row must
// stay actionable through the DB round-trip, the REST gate, and the GET.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  getCapability,
  isToolEnabled,
  seedBuiltinTools,
  setToolEnabled,
  upsertCapabilities,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildRecord } from '../../lib/capabilitySource/helpers'
import { recordToInsert, rowToRecord } from '../../lib/capabilitySource/mapper'
import { getDb, resetDb } from '../../lib/db'
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
    const db = getDb()
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
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
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
    const db = getDb()
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

  // The gate is deliberately NARROWER than CapabilitiesPanel's actionsFor: it reads
  // the tier (observe-only / writable), never `available` or `status`. This pins
  // that, because the tempting "make the gate symmetric with the UI" change wedges
  // exactly this row. A brokered tool disabled while it was available, whose
  // provider key later went away, reads available:false + status:'disabled'
  // (native.ts:92), and actionsFor's `!available` branch (CapabilitiesPanel.tsx:67)
  // runs before its status branch, so the panel shows no Enable button. REST is the
  // only remaining way to turn it back on.
  it('enable on an UNAVAILABLE managed brokered tool passes the gate (available is state, not permission)', async () => {
    const db = getDb()
    // Required, not incidental: setToolEnabled UPDATEs an existing row, so on an
    // unseeded registry it is a silent no-op and isToolEnabled falls back to true,
    // which would make both assertions below vacuous.
    seedBuiltinTools(db)
    setToolEnabled(db, 'web_search', false)
    expect(isToolEnabled(db, 'web_search')).toBe(false)
    const rec = buildRecord({
      sourceId: 'native',
      runtime: 'clawboo-native',
      scope: 'global',
      kind: 'tool',
      sourceKey: 'web_search',
      origin: 'brokered-mcp',
      manageability: 'managed',
      name: 'web_search',
      // What native.ts emits for web_search with no TAVILY_API_KEY: the
      // availability requirement is unmet, and `!enabled` wins the status ternary.
      available: false,
      status: 'disabled',
    })
    upsertCapabilities(db, 'native', [recordToInsert(rec)])
    const r = mockRes()
    await capabilitiesActionPOST(req({ params: { action: 'enable' }, body: { id: rec.id } }), r.res)
    expect(r.status()).toBe(200)
    expect(isToolEnabled(db, 'web_search')).toBe(true)
  })

  function seedOpenClawConnector(db: ReturnType<typeof getDb>): ReturnType<typeof buildRecord> {
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

  // The tools.allow/deny surface, the ONE write openclaw.write() actually supports
  // (openclaw.ts:188). Same origin + manageability as the connector above; only
  // `kind` differs, which is the whole point of the carve-out. (#146)
  function seedOpenClawTool(db: ReturnType<typeof getDb>): ReturnType<typeof buildRecord> {
    const rec = buildRecord({
      sourceId: 'openclaw',
      runtime: 'openclaw',
      scope: 'global',
      kind: 'tool',
      sourceKey: 'shell',
      origin: 'openclaw-extension',
      manageability: 'runtime-of-record',
      name: 'shell',
      description: 'OpenClaw Gateway tool',
      available: true,
      status: 'ready',
      // NOT writable:false. toolRecord() omits it, so buildRecord defaults it true.
    })
    upsertCapabilities(db, 'openclaw', [recordToInsert(rec)])
    return rec
  }

  it('rowToRecord re-derives writable:false for a NON-TOOL runtime-of-record OpenClaw extension (degraded last-good DB keeps the gate)', () => {
    const db = getDb()
    const rec = seedOpenClawConnector(db)
    // The column does NOT persist `writable`; reading the row back + mapping must
    // RE-DERIVE writable:false so the dashboard's dead-button gate survives a
    // disconnected (last-good DB) OpenClaw source. A managed native tool stays actionable.
    expect(rowToRecord(getCapability(db, rec.id)!).writable).toBe(false)
    // NON-TOOL only: a tools.allow/deny row IS writable, see the tool test below. (#146)
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
    const db = getDb()
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

  it('rowToRecord keeps a runtime-of-record Gateway TOOL writable (config.patch is a real write path)', () => {
    const db = getDb()
    const rec = seedOpenClawTool(db)
    // The derivation must carve out `kind: 'tool'`: openclaw.write() supports
    // exactly `origin === 'openclaw-extension' && kind === 'tool'` (openclaw.ts:188),
    // so stamping the tool non-writable makes the one supported write unreachable
    // (#146). Post-fix the key is ABSENT (the mapper spreads it conditionally),
    // never `true`, hence not.toBe(false), matching the native assertion above.
    expect(rowToRecord(getCapability(db, rec.id)!).writable).not.toBe(false)
  })

  it('disable on a runtime-of-record Gateway TOOL passes the REST gate and reaches the adapter', async () => {
    const db = getDb()
    const rec = seedOpenClawTool(db)
    const r = mockRes()
    await capabilitiesActionPOST(
      req({ params: { action: 'disable' }, body: { id: rec.id } }),
      r.res,
    )
    // 422 is the REGRESSION signal: the gate wrongly blocked (#146). Getting past
    // it means the adapter ran. This suite never starts the shared operator
    // connection, so OpenClawCapabilitySource.write() throws `gateway_disconnected`
    // (openclaw.ts:181) BEFORE its own ownership/writability checks, and
    // unsupported() is the ONLY thing in that adapter that yields a 422. So a 422
    // here can only have come from the gate, and 503 is the one reachable post-gate
    // outcome. Asserting the specific code keeps this honest: a bare not.toBe(422)
    // would also pass on an unrelated crash.
    expect(r.status()).not.toBe(422)
    expect(r.status()).toBe(503)
    expect((r.body() as { error: string }).error).toBe('gateway_disconnected')
  })

  it('GET serves a Gateway TOOL as writable on the degraded last-good path (the panel keeps its action button)', async () => {
    const db = getDb()
    const rec = seedOpenClawTool(db)
    const r = mockRes()
    await capabilitiesListGET(req({ query: { runtime: 'openclaw' } }), r.res)
    expect(r.status()).toBe(200)
    const body = r.body() as {
      records: Array<{ id: string; writable?: boolean }>
      sources: Array<{ sourceId: string; ok: boolean }>
    }
    // The openclaw source is disconnected here, so loadCapabilities serves this row
    // from the table through rowToRecord (service.ts:58-62), the exact path the
    // derivation exists for. A writable:false here makes CapabilitiesPanel's
    // actionsFor drop the button (CapabilitiesPanel.tsx:71), so the bug is a missing
    // button as much as it is a 422. Being degraded also means the source-scoped
    // reconcile skips openclaw, so the seeded row survives the read.
    expect(body.sources.find((s) => s.sourceId === 'openclaw')?.ok).toBe(false)
    // Assert the row was SERVED before asserting its flag: `find(...)?.writable` is
    // `undefined` when the record is absent, and `undefined` is `not.toBe(false)`,
    // so without this the assertion would still pass if the degraded path broke.
    const served = body.records.find((x) => x.id === rec.id)
    expect(served).toBeDefined()
    expect(served?.writable).not.toBe(false)
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
