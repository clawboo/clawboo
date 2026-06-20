// capabilitiesClient — defensive REST helpers (never throw). The `ok` discriminant
// on fetchCapabilities is the signal both the Ghost Graph (filesError) and the
// Capabilities dashboard (error banner) use to distinguish a FETCH FAILURE from a
// genuinely empty inventory. fetch is stubbed per-case.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchCapabilities } from '../capabilitiesClient'

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch)
}
const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const fail = (status = 500): Response =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

afterEach(() => vi.unstubAllGlobals())

describe('fetchCapabilities', () => {
  it('returns ok:true with the records/sources on a successful fetch', async () => {
    stubFetch(() =>
      ok({ records: [{ id: 'native:echo' }], sources: [{ sourceId: 'native', ok: true }] }),
    )
    const view = await fetchCapabilities()
    expect(view.ok).toBe(true)
    expect(view.records).toHaveLength(1)
    expect(view.sources).toHaveLength(1)
  })

  it('returns ok:false (empty view) on a non-2xx response — a failure, not genuine emptiness', async () => {
    stubFetch(() => fail(500))
    const view = await fetchCapabilities()
    expect(view.ok).toBe(false)
    expect(view.records).toEqual([])
    expect(view.sources).toEqual([])
  })

  it('returns ok:false on a network throw', async () => {
    stubFetch(() => {
      throw new Error('network down')
    })
    const view = await fetchCapabilities()
    expect(view.ok).toBe(false)
  })
})
