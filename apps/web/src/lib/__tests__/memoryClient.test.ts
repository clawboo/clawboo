// memoryClient — defensive REST helpers (never throw; safe empty/null on
// failure; correct query strings). fetch is stubbed per-case.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { browseMemory, getProvider, saveFact, searchMemory } from '../memoryClient'

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
    expect(r.ok).toBe(true)

    stubFetch(() => fail())
    expect(await browseMemory()).toEqual({ facts: [], procedures: [], ok: false })
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
