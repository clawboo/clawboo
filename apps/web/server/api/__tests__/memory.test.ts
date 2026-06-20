// Memory REST: the provider read + procedures in browse, plus the search/save
// happy path. Sandbox HOME so the sqlite db lands in a throwaway dir; the
// embedding provider resolves to null (FTS-only) in CI (no Ollama / OpenAI key),
// so vector backing is absent but search still works via FTS.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { memoryBrowseGET, memoryProviderGET, memorySavePOST, memorySearchGET } from '../memory'

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

describe('memory REST', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-memory-rest-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('save fact → search hit; save procedure → browse returns both tiers; provider shape', async () => {
    const save = mockRes()
    await memorySavePOST(
      req({
        body: {
          kind: 'fact',
          title: 'Alpha note',
          content: 'the quick brown fox jumps',
          tags: ['t1'],
        },
      }),
      save.res,
    )
    expect(save.status()).toBe(200)

    const search = mockRes()
    await memorySearchGET(
      req({ query: { query: 'quick fox', mode: 'fts' } as Request['query'] }),
      search.res,
    )
    expect(search.status()).toBe(200)
    expect((search.body() as { results: unknown[] }).results.length).toBeGreaterThan(0)

    const proc = mockRes()
    await memorySavePOST(
      req({ body: { kind: 'procedure', name: 'deploy', content: 'step 1 then step 2' } }),
      proc.res,
    )
    expect(proc.status()).toBe(200)

    const browse = mockRes()
    await memoryBrowseGET(req(), browse.res)
    expect(browse.status()).toBe(200)
    const body = browse.body() as { facts: unknown[]; procedures: unknown[] }
    expect(body.facts.length).toBeGreaterThan(0)
    expect(body.procedures.length).toBeGreaterThan(0)

    const prov = mockRes()
    await memoryProviderGET(req(), prov.res)
    expect(prov.status()).toBe(200)
    const pv = (prov.body() as { provider: { id: string; dimensions: number } | null }).provider
    expect(pv === null || (typeof pv.id === 'string' && typeof pv.dimensions === 'number')).toBe(
      true,
    )
  })
})
