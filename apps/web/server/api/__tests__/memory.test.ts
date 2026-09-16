// Memory REST: the provider read + procedures in browse, plus the search/save
// happy path. Sandbox HOME so the sqlite db lands in a throwaway dir; the
// embedding provider resolves to null (FTS-only) in CI (no Ollama / OpenAI key),
// so vector backing is absent but search still works via FTS.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  memoryBrowseGET,
  memoryFeedbackPOST,
  memoryGraphGET,
  memoryOutcomesGET,
  memoryProviderGET,
  memorySavePOST,
  memorySearchGET,
} from '../memory'

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

  async function saveFact(
    title: string,
    content: string,
    tags?: string[],
  ): Promise<{ id: string }> {
    const save = mockRes()
    await memorySavePOST(req({ body: { kind: 'fact', title, content, tags } }), save.res)
    expect(save.status()).toBe(200)
    return (save.body() as { fact: { id: string } }).fact
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it('graph: seeded facts + collapsed procedure versions project into nodes/edges/honesty fields', async () => {
    await saveFact('Alpha', 'first shared note', ['shared'])
    await saveFact('Beta', 'second shared note', ['shared'])
    await saveFact('Gamma', 'third shared note', ['shared'])
    for (const step of ['step one', 'step two']) {
      const p = mockRes()
      await memorySavePOST(
        req({ body: { kind: 'procedure', name: 'deploy', content: step } }),
        p.res,
      )
      expect(p.status()).toBe(200)
    }

    const g = mockRes()
    await memoryGraphGET(req(), g.res)
    expect(g.status()).toBe(200)
    const body = g.body() as {
      ok: boolean
      graph: {
        nodes: Array<{ kind: string; versionCount?: number; learning: unknown }>
        edges: Array<{ kind: string; sharedTags: string[] }>
        totalFacts: number
        totalProcedures: number
        truncated: boolean
        similarityAvailable: boolean
      }
      provider: { id: string } | null
    }
    expect(body.ok).toBe(true)
    // 3 facts + ONE collapsed procedure node (2 versions → versionCount 2).
    expect(body.graph.nodes.length).toBe(4)
    const proc = body.graph.nodes.find((n) => n.kind === 'procedure')
    expect(proc?.versionCount).toBe(2)
    const tagEdges = body.graph.edges.filter((e) => e.kind === 'tag')
    expect(tagEdges.length).toBeGreaterThan(0)
    expect(tagEdges[0]?.sharedTags).toContain('shared')
    expect(body.graph.totalFacts).toBe(3)
    expect(body.graph.totalProcedures).toBe(1)
    expect(body.graph.truncated).toBe(false)
    // The learning slot is present on every node (null — no outcomes recorded).
    expect(body.graph.nodes.every((n) => n.learning === null)).toBe(true)
    // Honesty: without an embedding provider, similarity links are impossible.
    if (body.provider === null) expect(body.graph.similarityAvailable).toBe(false)

    const bad = mockRes()
    await memoryGraphGET(req({ query: { limit: '0' } as Request['query'] }), bad.res)
    expect(bad.status()).toBe(400)
  })

  it('feedback: 404 unknown, 400 corrected-without-note, distinct-corroborator transition to preferred', async () => {
    const fact = await saveFact('Stripe', 'payments go through Stripe checkout')

    const missing = mockRes()
    await memoryFeedbackPOST(
      req({ body: { factId: '00000000-0000-0000-0000-000000000000', outcome: 'useful' } }),
      missing.res,
    )
    expect(missing.status()).toBe(404)

    const noNote = mockRes()
    await memoryFeedbackPOST(req({ body: { factId: fact.id, outcome: 'corrected' } }), noNote.res)
    expect(noNote.status()).toBe(400)

    // UI user (no agent) → one corroborator, even twice.
    const first = mockRes()
    await memoryFeedbackPOST(req({ body: { factId: fact.id, outcome: 'useful' } }), first.res)
    expect(first.status()).toBe(200)
    expect((first.body() as { learning: { status: string } }).learning.status).toBe('tentative')
    await sleep(5)

    // A DISTINCT reporter (agent-scoped) → preferred. Prefix cite accepted.
    const second = mockRes()
    await memoryFeedbackPOST(
      req({
        body: { factId: fact.id.slice(0, 8), outcome: 'useful', scope: { agentId: 'agent-x' } },
      }),
      second.res,
    )
    expect(second.status()).toBe(200)
    const entry = (second.body() as { learning: { status: string; usefulCount: number } }).learning
    expect(entry.status).toBe('preferred')
    expect(entry.usefulCount).toBe(2)

    // Browse carries the sibling learning map keyed by fact id.
    const browse = mockRes()
    await memoryBrowseGET(req(), browse.res)
    const learning = (browse.body() as { learning: Record<string, { status: string }> }).learning
    expect(learning[fact.id]?.status).toBe('preferred')
  })

  it('outcomes: full trail newest-first (and 404 for an unknown fact)', async () => {
    const fact = await saveFact('Deploy', 'we release on Fridays')
    await memoryFeedbackPOST(req({ body: { factId: fact.id, outcome: 'useful' } }), mockRes().res)
    await sleep(5)
    await memoryFeedbackPOST(
      req({ body: { factId: fact.id, outcome: 'dead_end', scope: { agentId: 'agent-x' } } }),
      mockRes().res,
    )

    const out = mockRes()
    await memoryOutcomesGET(req({ query: { factId: fact.id } as Request['query'] }), out.res)
    expect(out.status()).toBe(200)
    const body = out.body() as {
      factId: string
      outcomes: Array<{ outcome: string; createdAt: number }>
    }
    expect(body.factId).toBe(fact.id)
    expect(body.outcomes.length).toBe(2)
    expect(body.outcomes[0]?.outcome).toBe('dead_end') // newest first
    expect(body.outcomes[0]!.createdAt).toBeGreaterThanOrEqual(body.outcomes[1]!.createdAt)

    const missing = mockRes()
    await memoryOutcomesGET(
      req({ query: { factId: '11111111-aaaa' } as Request['query'] }),
      missing.res,
    )
    expect(missing.status()).toBe(404)
  })

  it('save stamps user provenance on both branches', async () => {
    const save = mockRes()
    await memorySavePOST(req({ body: { kind: 'fact', title: 'X', content: 'y' } }), save.res)
    const fact = (save.body() as { fact: { createdByRuntime: string; createdByAgentId: null } })
      .fact
    expect(fact.createdByRuntime).toBe('user')
    expect(fact.createdByAgentId).toBeNull()

    const proc = mockRes()
    await memorySavePOST(
      req({ body: { kind: 'procedure', name: 'ship', content: 'step' } }),
      proc.res,
    )
    expect(
      (proc.body() as { procedure: { createdByRuntime: string } }).procedure.createdByRuntime,
    ).toBe('user')
  })
})
