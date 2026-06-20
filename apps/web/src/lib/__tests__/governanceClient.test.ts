// governanceClient — defensive REST helpers (never throw; safe empty/null on
// failure; correct routes + query strings). fetch is stubbed per-case.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { listAudit, listBudgets, resumeBudget, setBudget } from '../governanceClient'

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch)
}
const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const fail = (status = 500): Response =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

afterEach(() => vi.unstubAllGlobals())

describe('governanceClient', () => {
  it('listBudgets parses budgets (ok:true; empty + ok:false on failure)', async () => {
    stubFetch(() =>
      ok({ budgets: [{ id: 'b1', scope: 'agent', scopeId: 'a1', status: 'active' }] }),
    )
    const r = await listBudgets()
    expect(r.budgets).toHaveLength(1)
    expect(r.ok).toBe(true)
    stubFetch(() => fail())
    expect(await listBudgets()).toEqual({ budgets: [], ok: false })
  })

  it('setBudget posts the cap and returns the budget (null on failure)', async () => {
    let bodyStr = ''
    stubFetch((_url, init) => {
      bodyStr = String(init?.body ?? '')
      return ok({ budget: { id: 'b1', limitUsdCents: 500 } })
    })
    const b = await setBudget({ scope: 'agent', scopeId: 'a1', limitUsdCents: 500 })
    expect(b?.id).toBe('b1')
    expect(JSON.parse(bodyStr)).toMatchObject({ scope: 'agent', scopeId: 'a1', limitUsdCents: 500 })
    stubFetch(() => fail())
    expect(await setBudget({ scope: 'agent', scopeId: 'a1', limitUsdCents: 1 })).toBeNull()
  })

  it('resumeBudget hits the scoped resume route and surfaces willRepause', async () => {
    let seen = ''
    let bodyStr = ''
    stubFetch((url, init) => {
      seen = url
      bodyStr = String(init?.body ?? '')
      return ok({ budget: { id: 'b1', status: 'active' }, willRepause: true })
    })
    const r = await resumeBudget('mission', 'm 1', 200)
    expect(r.budget?.status).toBe('active')
    expect(r.willRepause).toBe(true)
    expect(JSON.parse(bodyStr)).toMatchObject({ graceUsdCents: 200 })
    expect(seen).toBe('/api/governance/budgets/mission/m%201/resume')
  })

  it('listAudit threads agent/eventType/since/limit filters', async () => {
    let seen = ''
    stubFetch((url) => {
      seen = url
      return ok({ audit: [{ id: 'x', eventType: 'budget' }] })
    })
    const rows = await listAudit({
      agentId: 'a1',
      eventType: 'circuit_break',
      since: 123,
      limit: 50,
    })
    expect(rows).toHaveLength(1)
    expect(seen).toContain('agentId=a1')
    expect(seen).toContain('eventType=circuit_break')
    expect(seen).toContain('since=123')
    expect(seen).toContain('limit=50')
    stubFetch(() => fail())
    expect(await listAudit()).toEqual([])
  })
})
