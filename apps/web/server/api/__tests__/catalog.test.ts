// The catalog endpoints, exercised offline.
//
// There is no network here on purpose. `lib/catalogIndex.ts` resolves tier 0 -
// the local `catalog/dist/v1/` - whenever it exists above the module, which is
// always true in a checkout. That is the same path a contributor gets on a
// branch whose catalog has never been pushed anywhere, so it is the path worth
// testing.
//
// WHAT THESE PROVE, in order: the index is never empty, it is the seed UNION
// the packs on disk, one entry resolves to a real body, an unknown id is a 404
// rather than a 200 with nothing in it, and every member of a builtin team has
// a deployable body - which is the whole first-run onboarding contract, since
// `SelectTeamStep` renders with `allowStartFromScratch={false}`.

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it } from 'vitest'

import { SEED_INDEX, SEED_PACK_ID } from '../../lib/catalogSeed'
import { resetCatalogCache } from '../../lib/catalogIndex'
import { catalogAgentGET, catalogIndexGET, catalogTeamGET } from '../catalog'

interface IndexBody {
  schemaVersion: number
  counts: { agents: number; teams: number }
  agents: { id: string; packId: string }[]
  teams: { id: string; packId: string; agentIds: string[] }[]
  packs: { id: string; offline?: boolean }[]
}

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

const req = (params: Record<string, string> = {}): Request =>
  ({ params, query: {}, body: {} }) as unknown as Request

async function loadIndex(): Promise<IndexBody> {
  const { res, body } = mockRes()
  await catalogIndexGET(req(), res)
  return body() as IndexBody
}

describe('GET /api/catalog/index', () => {
  beforeEach(() => {
    resetCatalogCache()
  })

  it('is never empty: it always carries at least the compiled seed', async () => {
    const index = await loadIndex()
    expect(index.schemaVersion).toBe(SEED_INDEX.schemaVersion)
    expect(index.counts.teams).toBeGreaterThanOrEqual(SEED_INDEX.counts.teams)
    for (const seeded of SEED_INDEX.teams) {
      expect(
        index.teams.some((t) => t.id === seeded.id),
        `seeded team ${seeded.id} is missing from the merged index`,
      ).toBe(true)
    }
  })

  it('merges the packs on disk on top of the seed', async () => {
    const index = await loadIndex()
    // The seed is one pack; the tree ships more than one, so a merged index has
    // rows the seed does not.
    expect(index.counts.agents).toBeGreaterThan(SEED_INDEX.counts.agents)
    expect(new Set(index.agents.map((a) => a.packId)).size).toBeGreaterThan(1)
    expect(index.packs.map((p) => p.id)).toContain(SEED_PACK_ID)
  })

  it('reports counts that agree with the arrays they describe', async () => {
    const index = await loadIndex()
    expect(index.counts.agents).toBe(index.agents.length)
    expect(index.counts.teams).toBe(index.teams.length)
  })
})

describe('GET /api/catalog/agents/:id', () => {
  beforeEach(() => {
    resetCatalogCache()
  })

  it('returns the agent document set', async () => {
    const index = await loadIndex()
    const id = index.agents[0]!.id
    const { res, status, body } = mockRes()
    await catalogAgentGET(req({ id }), res)
    expect(status()).toBe(200)
    const doc = body() as { id: string; files: Record<string, string> }
    expect(doc.id).toBe(id)
    expect(doc.files['SOUL.md']?.length).toBeGreaterThan(0)
    expect(doc.files['IDENTITY.md']?.length).toBeGreaterThan(0)
  })

  it('404s on an unknown id rather than answering with an empty body', async () => {
    const { res, status } = mockRes()
    await catalogAgentGET(req({ id: 'not-a-real-agent' }), res)
    expect(status()).toBe(404)
  })
})

describe('GET /api/catalog/teams/:id', () => {
  beforeEach(() => {
    resetCatalogCache()
  })

  it('returns the team body', async () => {
    const seeded = SEED_INDEX.teams[0]!
    const { res, status, body } = mockRes()
    await catalogTeamGET(req({ id: seeded.id }), res)
    expect(status()).toBe(200)
    expect((body() as { id: string }).id).toBe(seeded.id)
  })

  it('404s on an unknown id', async () => {
    const { res, status } = mockRes()
    await catalogTeamGET(req({ id: 'not-a-real-team' }), res)
    expect(status()).toBe(404)
  })
})

describe('the deploy path', () => {
  beforeEach(() => {
    resetCatalogCache()
  })

  it('resolves a full roster for every builtin team, with routing for each member', async () => {
    const index = await loadIndex()
    const missing: string[] = []
    for (const seeded of SEED_INDEX.teams) {
      const row = index.teams.find((t) => t.id === seeded.id)
      if (!row) {
        missing.push(`${seeded.id} (no index row)`)
        continue
      }
      const { res: teamRes, body: teamBody } = mockRes()
      await catalogTeamGET(req({ id: seeded.id }), teamRes)
      const routing = (teamBody() as { routing?: Record<string, string> }).routing ?? {}
      expect(row.agentIds.length).toBeGreaterThan(1)
      for (const agentId of row.agentIds) {
        const { res, status, body } = mockRes()
        await catalogAgentGET(req({ id: agentId }), res)
        if (status() !== 200) {
          missing.push(`${seeded.id} -> ${agentId} (no body)`)
          continue
        }
        const files = (body() as { files: Record<string, string> }).files
        if (!files['SOUL.md'] || !files['IDENTITY.md']) {
          missing.push(`${seeded.id} -> ${agentId} (incomplete body)`)
        }
        if (!routing[agentId]) missing.push(`${seeded.id} -> ${agentId} (no routing)`)
      }
    }
    expect(missing).toEqual([])
  })
})
