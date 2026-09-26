// memoryClient — defensive REST helpers (never throw; safe empty/null on
// failure; correct query strings). fetch is stubbed per-case.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  browseMemory,
  fetchMemoryGraph,
  getOutcomes,
  getProvider,
  recordFeedback,
  saveFact,
  searchMemory,
} from '../memoryClient'

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch)
}
const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const fail = (status = 500): Response =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

afterEach(() => vi.unstubAllGlobals())

describe('memoryClient', () => {
  it('searchMemory builds query/mode/limit and parses results', async () => {
    let seen = ''
    stubFetch((url) => {
      seen = url
      return ok({
        results: [{ id: '1', title: 'x', content: 'y', tags: [], score: 0.5, matchedVia: 'fts' }],
      })
    })
    const r = await searchMemory('the fox', 'hybrid', { limit: 7 })
    expect(r).toHaveLength(1)
    expect(seen).toContain('query=the+fox')
    expect(seen).toContain('mode=hybrid')
    expect(seen).toContain('limit=7')
  })

  it('searchMemory returns [] on non-ok and on throw', async () => {
    stubFetch(() => fail(404))
    expect(await searchMemory('q', 'fts')).toEqual([])
    stubFetch(() => {
      throw new Error('network')
    })
    expect(await searchMemory('q', 'fts')).toEqual([])
  })

  it('saveFact posts kind:fact and returns the fact (null on failure)', async () => {
    let bodyStr = ''
    stubFetch((_url, init) => {
      bodyStr = String(init?.body ?? '')
      return ok({ fact: { id: 'f1', title: 't', content: 'c', tags: [] } })
    })
    const f = await saveFact({ title: 't', content: 'c' })
    expect(f?.id).toBe('f1')
    expect(JSON.parse(bodyStr)).toMatchObject({ kind: 'fact', title: 't' })

    stubFetch(() => fail())
    expect(await saveFact({ title: 't', content: 'c' })).toBeNull()
  })

  it('browseMemory returns both tiers (ok:true), and a safe empty pair (ok:false) on failure', async () => {
    stubFetch(() => ok({ facts: [{ id: 'f' }], procedures: [{ id: 'p' }] }))
    const r = await browseMemory()
    expect(r.facts).toHaveLength(1)
    expect(r.procedures).toHaveLength(1)
    expect(r.learning).toEqual({}) // additive map defaults to {} when absent
    expect(r.ok).toBe(true)

    stubFetch(() => fail())
    expect(await browseMemory()).toEqual({ facts: [], procedures: [], learning: {}, ok: false })
  })

  it('browseMemory parses the sibling learning map', async () => {
    stubFetch(() =>
      ok({ facts: [{ id: 'f' }], procedures: [], learning: { f: { status: 'preferred' } } }),
    )
    const r = await browseMemory()
    expect(r.learning['f']?.status).toBe('preferred')
  })

  it('searchMemory merges the sibling learning map into results client-side', async () => {
    stubFetch(() =>
      ok({
        results: [
          { id: 'a', title: 'x', content: 'y', tags: [], score: 0.5, matchedVia: 'fts' },
          { id: 'b', title: 'x', content: 'y', tags: [], score: 0.4, matchedVia: 'fts' },
        ],
        learning: { a: { status: 'tentative' } },
      }),
    )
    const r = await searchMemory('q', 'fts')
    expect(r[0]?.learning?.status).toBe('tentative')
    expect(r[1]?.learning).toBeUndefined()
  })

  it('fetchMemoryGraph returns { graph, provider } and null on failure/absent graph', async () => {
    const graph = {
      nodes: [],
      edges: [],
      communities: [],
      totalFacts: 0,
      totalProcedures: 0,
      truncated: false,
      similarityAvailable: false,
    }
    let seen = ''
    stubFetch((url) => {
      seen = url
      return ok({ ok: true, graph, provider: { id: 'ollama', dimensions: 768 } })
    })
    const r = await fetchMemoryGraph({ limit: 100 })
    expect(seen).toContain('/api/memory/graph')
    expect(seen).toContain('limit=100')
    expect(r?.graph).toEqual(graph)
    expect(r?.provider).toEqual({ id: 'ollama', dimensions: 768 })

    stubFetch(() => ok({ ok: true })) // graph missing → null (defensive)
    expect(await fetchMemoryGraph()).toBeNull()
    stubFetch(() => fail())
    expect(await fetchMemoryGraph()).toBeNull()
  })

  it('recordFeedback posts factId/outcome(/note) and returns the entry (null on failure)', async () => {
    let bodyStr = ''
    stubFetch((_url, init) => {
      bodyStr = String(init?.body ?? '')
      return ok({ ok: true, learning: { status: 'tentative' } })
    })
    const entry = await recordFeedback('fact-1234', 'useful')
    expect(entry?.status).toBe('tentative')
    expect(JSON.parse(bodyStr)).toEqual({ factId: 'fact-1234', outcome: 'useful' })

    await recordFeedback('fact-1234', 'corrected', 'actually X')
    expect(JSON.parse(bodyStr)).toEqual({
      factId: 'fact-1234',
      outcome: 'corrected',
      note: 'actually X',
    })

    stubFetch(() => fail())
    expect(await recordFeedback('fact-1234', 'dead_end')).toBeNull()
  })

  it('getOutcomes builds the factId query and returns [] on failure', async () => {
    let seen = ''
    stubFetch((url) => {
      seen = url
      return ok({ ok: true, outcomes: [{ id: 'o1', outcome: 'useful' }] })
    })
    const r = await getOutcomes('fact-1234')
    expect(seen).toContain('/api/memory/outcomes')
    expect(seen).toContain('factId=fact-1234')
    expect(r).toHaveLength(1)

    stubFetch(() => fail())
    expect(await getOutcomes('fact-1234')).toEqual([])
  })

  it('getProvider parses the provider (null when absent/failed)', async () => {
    stubFetch(() => ok({ provider: { id: 'ollama:nomic', dimensions: 768 } }))
    expect(await getProvider()).toEqual({ id: 'ollama:nomic', dimensions: 768 })
    stubFetch(() => ok({ provider: null }))
    expect(await getProvider()).toBeNull()
    stubFetch(() => fail())
    expect(await getProvider()).toBeNull()
  })
})
