// A failed catalog refresh, and how long its fallback is kept.
//
// `api/__tests__/catalog.test.ts` runs on tier 0, the local `catalog/dist/v1/`
// that every checkout has. Here that tier is hidden, so the index has to come
// over the network, and the network fails.

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

// Which index a build reads. A release used to read main's, so every install
// got whatever main held that day, content written for a newer version included,
// and one push to main changed every install at once.
describe('where the catalog index comes from', () => {
  const fetchMock = vi.fn()
  const MAIN =
    'https://raw.githubusercontent.com/clawboo/clawboo/refs/heads/main/catalog/dist/v1/index.json'
  const TAG_050 =
    'https://raw.githubusercontent.com/clawboo/clawboo/refs/tags/clawboo%400.5.0/catalog/dist/v1/index.json'
  const emptyIndex = () =>
    new Response(JSON.stringify({ schemaVersion: 1, packs: [] }), { status: 200 })
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]))

  beforeEach(() => {
    resetCatalogCache()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetCatalogCache()
  })

  it("a release reads its own release tag's index", async () => {
    vi.stubEnv('CLAWBOO_VERSION', '0.5.0')
    fetchMock.mockResolvedValue(emptyIndex())

    await getCatalogSnapshot()
    expect(urls()).toEqual([TAG_050])
  })

  it("falls back to main's index when the release has no tag", async () => {
    vi.stubEnv('CLAWBOO_VERSION', '0.5.0')
    fetchMock
      .mockResolvedValueOnce(new Response('404: Not Found', { status: 404 }))
      .mockResolvedValueOnce(emptyIndex())

    await getCatalogSnapshot()
    expect(urls()).toEqual([TAG_050, MAIN])
  })

  it("fetches a pack from main's tree after falling back to main's index", async () => {
    vi.stubEnv('CLAWBOO_VERSION', '0.5.0')
    // Fetched packs are cached under the Clawboo folder; keep this one out of it.
    const home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-catalog-fallback-'))
    vi.stubEnv('CLAWBOO_HOME', home)
    const bundle = '{"fixture":"pack bytes"}'
    const integrity = `sha256-${createHash('sha256').update(bundle, 'utf8').digest('base64')}`
    const index = {
      schemaVersion: 1,
      packs: [
        {
          publisher: 'fixture',
          slug: 'pack',
          id: 'fixture/pack',
          version: '1.0.0',
          path: 'v1/packs/fixture/pack/1.0.0.json',
          integrity,
        },
      ],
    }
    fetchMock
      .mockResolvedValueOnce(new Response('404: Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(index), { status: 200 }))
      .mockResolvedValueOnce(new Response(bundle, { status: 200 }))

    try {
      await getCatalogSnapshot()
      expect(urls()).toEqual([
        TAG_050,
        MAIN,
        'https://raw.githubusercontent.com/clawboo/clawboo/refs/heads/main/catalog/dist/v1/packs/fixture/pack/1.0.0.json',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not fall back when the network is down, which main cannot fix', async () => {
    vi.stubEnv('CLAWBOO_VERSION', '0.5.0')
    fetchMock.mockRejectedValue(new Error('offline'))

    await getCatalogSnapshot()
    expect(urls()).toEqual([TAG_050])
  })

  it.each(['0.0.0-dev', '0.0.0'])('a development build (%s) keeps reading main', async (v) => {
    vi.stubEnv('CLAWBOO_VERSION', v)
    fetchMock.mockResolvedValue(emptyIndex())

    await getCatalogSnapshot()
    expect(urls()).toEqual([MAIN])
  })

  it('CLAWBOO_CATALOG_INDEX_URL still overrides, with no fallback', async () => {
    vi.stubEnv('CLAWBOO_VERSION', '0.5.0')
    vi.stubEnv('CLAWBOO_CATALOG_INDEX_URL', 'https://mirror.example.com/catalog/v1/index.json')
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))

    await getCatalogSnapshot()
    expect(urls()).toEqual(['https://mirror.example.com/catalog/v1/index.json'])
  })
})
