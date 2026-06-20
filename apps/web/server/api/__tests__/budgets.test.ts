// Governance REST CRUD. Sandboxes `$HOME` so the sqlite db lands in a throwaway
// dir. Covers the set/list/resume + audit happy paths and the delegation-approval
// sticky-scope fast-path.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createApproval, createDb, recordSpend, resolveApproval } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { budgetsListGET, budgetsResumePOST, budgetsSetPOST } from '../budgets'
import { delegationApprovalPOST } from '../delegationApproval'
import { governanceAuditGET } from '../governanceAudit'

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
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
  return { res, statusCode: () => code, body: () => payload }
}
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

describe('governance REST', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-budget-rest-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('set / list / resume + audit happy paths', () => {
    const set = mockRes()
    budgetsSetPOST(req({ body: { scope: 'agent', scopeId: 'a1', limitUsdCents: 500 } }), set.res)
    expect(set.statusCode()).toBe(200)
    expect((set.body() as { budget: { limitUsdCents: number } }).budget.limitUsdCents).toBe(500)

    const list = mockRes()
    budgetsListGET(req(), list.res)
    expect((list.body() as { budgets: unknown[] }).budgets.length).toBe(1)

    const resume = mockRes()
    budgetsResumePOST(req({ params: { scope: 'agent', scopeId: 'a1' } }), resume.res)
    expect(resume.statusCode()).toBe(200)
    expect((resume.body() as { budget: { status: string } }).budget.status).toBe('active')

    const missing = mockRes()
    budgetsResumePOST(req({ params: { scope: 'agent', scopeId: 'nope' } }), missing.res)
    expect(missing.statusCode()).toBe(404)

    const bad = mockRes()
    budgetsSetPOST(req({ body: {} }), bad.res)
    expect(bad.statusCode()).toBe(400)

    const audit = mockRes()
    governanceAuditGET(req(), audit.res)
    expect(audit.statusCode()).toBe(200)
    expect(Array.isArray((audit.body() as { audit: unknown[] }).audit)).toBe(true)
  })

  it('rejects a budget limit of 0 (uncapped = no row, not a 0 cap)', () => {
    const zero = mockRes()
    budgetsSetPOST(req({ body: { scope: 'agent', scopeId: 'a1', limitUsdCents: 0 } }), zero.res)
    expect(zero.statusCode()).toBe(400)
  })

  it('resume surfaces willRepause + accepts a grace headroom', () => {
    // Set a cap, blow through it (paused), then bare-resume → willRepause true.
    budgetsSetPOST(
      req({ body: { scope: 'agent', scopeId: 'over', limitUsdCents: 100, mode: 'cap' } }),
      mockRes().res,
    )
    const db = createDb(getDbPath())
    recordSpend(db, 'agent', 'over', 150) // spent 150 > 100 → paused

    const bare = mockRes()
    budgetsResumePOST(req({ params: { scope: 'agent', scopeId: 'over' } }), bare.res)
    expect(bare.statusCode()).toBe(200)
    expect((bare.body() as { willRepause: boolean }).willRepause).toBe(true)

    // Resume WITH grace raises the cap above spend → no longer willRepause.
    const graced = mockRes()
    budgetsResumePOST(
      req({ params: { scope: 'agent', scopeId: 'over' }, body: { graceUsdCents: 100 } }),
      graced.res,
    )
    expect(graced.statusCode()).toBe(200)
    expect((graced.body() as { willRepause: boolean }).willRepause).toBe(false)
  })

  it('delegation-approval: 400 without leader, sticky allow_always fast-path', async () => {
    const bad = mockRes()
    await delegationApprovalPOST(req({ body: {} }), bad.res)
    expect(bad.statusCode()).toBe(400)

    // A prior allow_always for (leader, delegate:code) makes the gate resolve
    // immediately — no blocking wait (proves the sticky-scope short-circuit).
    const db = createDb(getDbPath())
    const a = createApproval(db, { toolName: 'delegate:code', agentId: 'leader1', args: {} })
    resolveApproval(db, a.id, 'allow_always')
    const sticky = mockRes()
    await delegationApprovalPOST(
      req({ body: { leaderAgentId: 'leader1', kind: 'code', task: 'deploy' } }),
      sticky.res,
    )
    expect(sticky.statusCode()).toBe(200)
    expect((sticky.body() as { resolution: string }).resolution).toBe('allow_always')
  })
})
