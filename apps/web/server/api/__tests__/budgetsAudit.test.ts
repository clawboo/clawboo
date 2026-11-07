// Budget edits leave a row: what changed, and who asked. A cap is what stands
// between a run and the money, so a raised limit or a resume must be on record.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getBudget, listGovernanceAudit, recordSpend, setBudgetLimit } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { budgetsResumePOST, budgetsSetPOST } from '../budgets'

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

function mockRes() {
  let status = 200
  let payload: unknown
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, code: () => status, body: () => payload as Record<string, unknown> }
}

const req = (
  body: unknown,
  params: Record<string, string> = {},
  headers: Record<string, string> = DASHBOARD,
): Request => ({ body, params, query: {}, headers, person: null }) as unknown as Request

const rows = () =>
  listGovernanceAudit(getDb(), { eventType: 'budget' }).map((r) => ({
    teamId: r.teamId,
    agentId: r.agentId,
    summary: JSON.parse(r.summary) as Record<string, unknown>,
  }))

let home: string
const prev: Record<string, string | undefined> = {}
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-budgets-audit-'))
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    prev[name] = process.env[name]
    process.env[name] = home
  }
  expect(getDbPath().startsWith(home)).toBe(true)
})
afterEach(async () => {
  resetDb()
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    if (prev[name] === undefined) delete process.env[name]
    else process.env[name] = prev[name]
  }
  await rm(home, { recursive: true, force: true })
})

describe('POST /api/governance/budgets', () => {
  it('records a new budget', () => {
    const r = mockRes()
    budgetsSetPOST(req({ scope: 'team', scopeId: 'T', limitUsdCents: 500, mode: 'cap' }), r.res)
    expect(r.code()).toBe(200)
    expect(rows()).toEqual([
      {
        teamId: 'T',
        agentId: null,
        summary: {
          reason: 'edit',
          action: 'set_limit',
          scope: 'team',
          scopeId: 'T',
          spentUsdCents: 0,
          before: null,
          after: { limitUsdCents: 500, mode: 'cap', status: 'active' },
          actor: { kind: 'person' },
        },
      },
    ])
  })

  it('records a raised limit with what it was, naming the agent it is for', () => {
    setBudgetLimit(getDb(), { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'warn' })
    budgetsSetPOST(req({ scope: 'agent', scopeId: 'a1', limitUsdCents: 900 }), mockRes().res)
    expect(rows()[0]).toMatchObject({
      agentId: 'a1',
      summary: {
        before: { limitUsdCents: 100, mode: 'warn' },
        after: { limitUsdCents: 900, mode: 'warn' },
      },
    })
  })

  it('refuses a caller the person check does not let through, and writes nothing', () => {
    const r = mockRes()
    budgetsSetPOST(req({ scope: 'team', scopeId: 'T', limitUsdCents: 500 }, {}, {}), r.res)
    expect(r.code()).toBe(403)
    expect(rows()).toEqual([])
    expect(getBudget(getDb(), 'team', 'T')).toBeNull()
  })

  it('records nothing for a body it refused', () => {
    const r = mockRes()
    budgetsSetPOST(req({ scope: 'nope' }), r.res)
    expect(r.code()).toBe(400)
    expect(rows()).toEqual([])
  })
})

describe('POST /api/governance/budgets/:scope/:scopeId/resume', () => {
  it('records a resume, and what it left the budget at', () => {
    setBudgetLimit(getDb(), { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
    recordSpend(getDb(), 'team', 'T', 150)
    const r = mockRes()
    budgetsResumePOST(req({ graceUsdCents: 200 }, { scope: 'team', scopeId: 'T' }), r.res)
    expect(r.code()).toBe(200)
    expect(rows()[0]?.summary).toMatchObject({
      reason: 'edit',
      action: 'resume',
      spentUsdCents: 150,
      before: { status: 'paused', limitUsdCents: 100 },
      after: { status: 'active' },
      actor: { kind: 'person' },
    })
  })

  it('records nothing for a budget that does not exist', () => {
    const r = mockRes()
    budgetsResumePOST(req({}, { scope: 'team', scopeId: 'nope' }), r.res)
    expect(r.code()).toBe(404)
    expect(rows()).toEqual([])
  })
})
