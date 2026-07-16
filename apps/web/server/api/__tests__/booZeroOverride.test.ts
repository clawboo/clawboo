// The Boo Zero OVERRIDE endpoints — the previously writer-less `boo-zero:agent-id`
// setting (`resolveBooZero` reads it FIRST: override → native → OpenClaw). The tests
// use a CODEX agent as the override on purpose: the designation is runtime-NEUTRAL
// by design, and this is what lets a ChatGPT-subscription (Codex) agent lead every
// team in a MIXED install where the default-native Boo Zero would otherwise win.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createDb, getSetting, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { resolveBooZero, SETTING_BOO_ZERO_OVERRIDE } from '../../lib/teamChat/booZero'
import { booZeroOverrideGET, booZeroOverridePOST } from '../booZeroOverride'

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
const req = (body: unknown): Request => ({ params: {}, query: {}, body }) as unknown as Request

describe('Boo Zero override (runtime-neutral leader designation)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-bz-override-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = createDb(getDbPath())
    const now = Date.now()
    db.insert(agents)
      .values([
        // A CODEX agent — any runtime is a legal override by design.
        {
          id: 'codex-lead',
          name: 'Codex Lead',
          gatewayId: 'codex-lead',
          sourceId: 'codex',
          runtime: 'codex',
          teamId: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'gone',
          name: 'Gone',
          gatewayId: 'gone',
          runtime: 'codex',
          teamId: null,
          archivedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('POST designates a CODEX agent as Boo Zero; resolveBooZero honours it first', () => {
    const { res, status, body } = mockRes()
    booZeroOverridePOST(req({ agentId: 'codex-lead' }), res)
    expect(status()).toBe(200)
    expect((body() as { overrideAgentId: string }).overrideAgentId).toBe('codex-lead')
    expect(getSetting(db, SETTING_BOO_ZERO_OVERRIDE)).toBe('codex-lead')
    expect(resolveBooZero(db)?.id).toBe('codex-lead')
  })

  it('POST null clears the override and restores the default resolution chain', () => {
    booZeroOverridePOST(req({ agentId: 'codex-lead' }), mockRes().res)
    const { res, status } = mockRes()
    booZeroOverridePOST(req({ agentId: null }), res)
    expect(status()).toBe(200)
    // No native / OpenClaw Boo Zero exists in this sandbox → chain resolves to null.
    expect(resolveBooZero(db)).toBeNull()
  })

  it('rejects an unknown or archived agent (404) and a malformed body (400)', () => {
    const unknown = mockRes()
    booZeroOverridePOST(req({ agentId: 'nope' }), unknown.res)
    expect(unknown.status()).toBe(404)

    const archived = mockRes()
    booZeroOverridePOST(req({ agentId: 'gone' }), archived.res)
    expect(archived.status()).toBe(404)

    const missing = mockRes()
    booZeroOverridePOST(req({}), missing.res)
    expect(missing.status()).toBe(400)

    const empty = mockRes()
    booZeroOverridePOST(req({ agentId: '   ' }), empty.res)
    expect(empty.status()).toBe(400)

    // None of the rejects stored anything.
    expect(getSetting(db, SETTING_BOO_ZERO_OVERRIDE) || null).toBeNull()
  })

  it('GET returns the stored override + the effective Boo Zero + the tier', () => {
    booZeroOverridePOST(req({ agentId: 'codex-lead' }), mockRes().res)
    const { res, status, body } = mockRes()
    booZeroOverrideGET(req({}), res)
    expect(status()).toBe(200)
    expect(body()).toEqual({
      overrideAgentId: 'codex-lead',
      effective: { id: 'codex-lead', name: 'Codex Lead' },
      tier: 'override',
    })
  })

  it('GET tier distinguishes the weak OpenClaw fallback from a deliberate leader', () => {
    // No override, no native Boo Zero → nothing resolves → tier null.
    const empty = mockRes()
    booZeroOverrideGET(req({}), empty.res)
    expect(body(empty)).toMatchObject({ overrideAgentId: null, effective: null, tier: null })

    // A teamless OpenClaw agent (the Gateway `main` residue) → the chain falls
    // back to it and the tier names it `openclaw` — the rung a codex-preferred
    // deploy may legitimately outrank (a deliberate override/native never is).
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'main',
        name: 'Test Boo',
        gatewayId: 'main',
        sourceId: 'openclaw',
        runtime: 'openclaw',
        teamId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const oc = mockRes()
    booZeroOverrideGET(req({}), oc.res)
    expect(body(oc)).toMatchObject({
      effective: { id: 'main', name: 'Test Boo' },
      tier: 'openclaw',
    })

    function body(m: ReturnType<typeof mockRes>) {
      return m.body() as Record<string, unknown>
    }
  })
})
