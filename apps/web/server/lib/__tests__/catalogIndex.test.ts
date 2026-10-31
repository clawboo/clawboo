// A failed catalog refresh, and how long its fallback is kept.
//
// `api/__tests__/catalog.test.ts` runs on tier 0, the local `catalog/dist/v1/`
// that every checkout has. Here that tier is hidden, so the index has to come
// over the network, and the network fails.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCatalogSnapshot, resetCatalogCache } from '../catalogIndex'
import { SEED_INDEX, SEED_PACK_ID } from '../catalogSeed'

vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>()
  const localIndex = /[\\/]catalog[\\/]dist[\\/]v1[\\/]index\.json$/
  return {
    ...fs,
    existsSync: (p: Parameters<typeof fs.existsSync>[0]) =>
      !localIndex.test(String(p)) && fs.existsSync(p),
  }
})

const SIX_HOURS = 6 * 60 * 60 * 1000

describe('a failed catalog refresh', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    resetCatalogCache()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetCatalogCache()
  })

  it.each([
    ['the network is down', () => fetchMock.mockRejectedValue(new Error('offline'))],
    ['the index answers 503', () => fetchMock.mockResolvedValue(new Response('', { status: 503 }))],
  ])('when %s, serves the seed and reuses it for 6 hours', async (_, fail) => {
    fail()

    const first = await getCatalogSnapshot()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.packs).toEqual([expect.objectContaining({ id: SEED_PACK_ID, offline: true })])
    expect(first.counts).toEqual(SEED_INDEX.counts)

    // Inside the window the fallback is served from the cache, like a success.
    expect(await getCatalogSnapshot(Date.now() + SIX_HOURS - 60_000)).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Past it, the next call tries the network again.
    await getCatalogSnapshot(Date.now() + SIX_HOURS + 60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
