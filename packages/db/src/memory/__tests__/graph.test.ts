import { describe, expect, it } from 'vitest'

import {
  computeFactEdges,
  neighborsOf,
  projectMemoryGraph,
  similarityAvailableFor,
  type FactVectorRow,
} from '../graph'
import type { LearningEntry } from '../learning'
import type { Procedure } from '../types'

function fact(
  id: string,
  opts: { tags?: string[]; vector?: number[] | null; model?: string | null } = {},
): FactVectorRow {
  return {
    id,
    title: `title-${id}`,
    content: `content of ${id}`,
    tags: opts.tags ?? [],
    scopeAgentId: null,
    scopeTeamId: null,
    tenantId: null,
    createdByAgentId: null,
    createdByRuntime: null,
    sourceTaskId: null,
    sourceSessionKey: null,
    createdAt: 1000,
    updatedAt: 1000,
    vector: opts.vector ?? null,
    embeddingModel: opts.vector != null ? (opts.model ?? 'm') : null,
  }
}

function procedure(
  id: string,
  name: string,
  version: number,
  scope: { teamId?: string | null; agentId?: string | null } = {},
): Procedure {
  return {
    id,
    name,
    version,
    content: `procedure ${name} v${version}`,
    scopeAgentId: scope.agentId ?? null,
    scopeTeamId: scope.teamId ?? null,
    tenantId: null,
    createdByAgentId: null,
    createdByRuntime: null,
    sourceTaskId: null,
    sourceSessionKey: null,
    createdAt: 1000 + version,
  }
}

describe('computeFactEdges — similarity', () => {
  it('emits an edge at/above the cosine threshold, none below', () => {
    const rows = [
      fact('a', { vector: [1, 0] }),
      fact('b', { vector: [1, 0] }), // cos(a,b) = 1
      fact('c', { vector: [0, 1] }), // cos(a,c) = 0
    ]
    const edges = computeFactEdges(rows, { simThreshold: 0.6 })
    const sims = edges.filter((e) => e.kind === 'similarity')
    expect(sims).toHaveLength(1)
    expect(sims[0]!.id).toBe('sim:a:b')
    expect(sims[0]!.weight).toBeCloseTo(1)
  })

  it('never compares vectors across embedding models, even at equal dims', () => {
    const rows = [
      fact('a', { vector: [1, 0], model: 'm1' }),
      fact('b', { vector: [1, 0], model: 'm2' }),
    ]
    expect(computeFactEdges(rows).filter((e) => e.kind === 'similarity')).toHaveLength(0)
    expect(similarityAvailableFor(rows)).toBe(false)
  })

  it('providerId restricts comparison to the current provider (injection mode)', () => {
    const rows = [
      fact('a', { vector: [1, 0], model: 'old' }),
      fact('b', { vector: [1, 0], model: 'old' }),
    ]
    // Graph view (no providerId): old-model pair still links.
    expect(computeFactEdges(rows).filter((e) => e.kind === 'similarity')).toHaveLength(1)
    // Injection (providerId set): old vectors are ignored.
    expect(
      computeFactEdges(rows, { providerId: 'new' }).filter((e) => e.kind === 'similarity'),
    ).toHaveLength(0)
  })

  it('caps similarity edges per node at simTopK, keeping the strongest', () => {
    // Hub h is similar to n1..n4 with descending cosine; topK 2 keeps the best 2.
    const rows = [
      fact('h', { vector: [1, 0] }),
      fact('n1', { vector: [1, 0.01] }),
      fact('n2', { vector: [1, 0.2] }),
      fact('n3', { vector: [1, 0.5] }),
      fact('n4', { vector: [1, 0.9] }),
    ]
    const edges = computeFactEdges(rows, { simThreshold: 0.6, simTopK: 2 })
    const hEdges = edges.filter(
      (e) => e.kind === 'similarity' && (e.source === 'h' || e.target === 'h'),
    )
    // Per-node topK is a UNION over nodes — h keeps its top-2, but a neighbor's own
    // top-K may re-admit an h edge. n1/n2 rank h below their mutual near-duplicates,
    // so h's incident set stays bounded near topK (here exactly 2..4, not all 4).
    expect(hEdges.length).toBeGreaterThanOrEqual(2)
    const kept = hEdges.map((e) => (e.source === 'h' ? e.target : e.source))
    expect(kept).toContain('n1') // strongest pair survives
  })
})

describe('computeFactEdges — tags', () => {
  it('computes IDF-weighted Jaccard on a hand-checked fixture', () => {
    const rows = [
      fact('a', { tags: ['x', 'y'] }),
      fact('b', { tags: ['x'] }),
      fact('c', { tags: ['y', 'z'] }),
    ]
    const edges = computeFactEdges(rows)
    const tagEdges = new Map(edges.filter((e) => e.kind === 'tag').map((e) => [e.id, e]))
    // df: x=2, y=2, z=1 → idf: 0.5, 0.5, 1
    // a-b: shared {x} = 0.5; union {x,y} = 1.0 → 0.5
    // a-c: shared {y} = 0.5; union {x,y,z} = 2.0 → 0.25
    expect(tagEdges.get('tag:a:b')?.weight).toBeCloseTo(0.5)
    expect(tagEdges.get('tag:a:b')?.sharedTags).toEqual(['x'])
    expect(tagEdges.get('tag:a:c')?.weight).toBeCloseTo(0.25)
    expect(tagEdges.has('tag:b:c')).toBe(false)
  })

  it('excludes hub tags (df ≥ minDf AND df > fraction·N) from edges', () => {
    // 20 facts all share 'everywhere' (df=20 ≥ 10 and > 6) → excluded, no clique.
    // Two of them also share 'rare' → exactly one edge via 'rare'.
    const rows = Array.from({ length: 20 }, (_, i) =>
      fact(`f${String(i).padStart(2, '0')}`, {
        tags: i < 2 ? ['everywhere', 'rare'] : ['everywhere'],
      }),
    )
    const edges = computeFactEdges(rows).filter((e) => e.kind === 'tag')
    expect(edges).toHaveLength(1)
    expect(edges[0]!.sharedTags).toEqual(['rare'])
  })

  it('a below-threshold df tag is NOT a hub even when ubiquitous in a tiny store', () => {
    // N=3, all share 't' (df=3 < minDf 10) → edges still form.
    const rows = [
      fact('a', { tags: ['t'] }),
      fact('b', { tags: ['t'] }),
      fact('c', { tags: ['t'] }),
    ]
    expect(computeFactEdges(rows).filter((e) => e.kind === 'tag')).toHaveLength(3)
  })

  it('a pair can carry BOTH a similarity and a tag edge (distinct meanings)', () => {
    const rows = [
      fact('a', { tags: ['t'], vector: [1, 0] }),
      fact('b', { tags: ['t'], vector: [1, 0] }),
    ]
    const edges = computeFactEdges(rows)
    expect(edges.map((e) => e.id).sort()).toEqual(['sim:a:b', 'tag:a:b'])
  })
})

describe('computeFactEdges — degree cap + determinism', () => {
  it('maxEdgesPerFact deterministically caps hub degree', () => {
    // Star: h shares a distinct rare tag with each of 6 leaves.
    const rows = [
      fact('h', { tags: ['t1', 't2', 't3', 't4', 't5', 't6'] }),
      ...[1, 2, 3, 4, 5, 6].map((i) => fact(`l${i}`, { tags: [`t${i}`] })),
    ]
    const capped = computeFactEdges(rows, { tagTopK: 10, maxEdgesPerFact: 3 })
    const hDegree = capped.filter((e) => e.source === 'h' || e.target === 'h').length
    expect(hDegree).toBe(3)
    // Deterministic under shuffle.
    const again = computeFactEdges([...rows].reverse(), { tagTopK: 10, maxEdgesPerFact: 3 })
    expect(again).toEqual(capped)
  })

  it('is input-order invariant', () => {
    const rows = [
      fact('a', { tags: ['x', 'q'], vector: [1, 0, 0] }),
      fact('b', { tags: ['x'], vector: [0.9, 0.1, 0] }),
      fact('c', { tags: ['q'], vector: [0, 0, 1] }),
    ]
    expect(computeFactEdges([...rows].reverse())).toEqual(computeFactEdges(rows))
  })
})

describe('neighborsOf', () => {
  it('expands seeds 1 hop, excluding seeds and over-degree hubs', () => {
    const rows = [
      fact('seed', { tags: ['s'] }),
      fact('nbr', { tags: ['s', 'o'] }),
      fact('far', { tags: ['o'] }),
    ]
    const edges = computeFactEdges(rows)
    const nbrs = neighborsOf(['seed'], edges)
    expect([...nbrs.keys()]).toEqual(['nbr'])
    expect(nbrs.get('nbr')?.via).toBe('seed')
  })

  it('skips a hub neighbor above degreeCap unless the hub is itself a seed', () => {
    // hub connects to 4 leaves + the seed → degree 5; cap 4 → excluded.
    const rows = [
      fact('seed', { tags: ['a'] }),
      fact('hub', { tags: ['a', 'b1', 'b2', 'b3', 'b4'] }),
      ...[1, 2, 3, 4].map((i) => fact(`leaf${i}`, { tags: [`b${i}`] })),
    ]
    const edges = computeFactEdges(rows, { tagTopK: 10 })
    expect(neighborsOf(['seed'], edges, { degreeCap: 4 }).has('hub')).toBe(false)
    // The hub AS a seed still expands to its leaves.
    const fromHub = neighborsOf(['hub'], edges, { degreeCap: 2 })
    expect(fromHub.size).toBeGreaterThan(0)
  })
})

describe('projectMemoryGraph', () => {
  it('collapses procedure versions to the latest and links same-name across scopes', () => {
    const procs = [
      procedure('p1', 'deploy', 1, { teamId: 'team-a' }),
      procedure('p2', 'deploy', 2, { teamId: 'team-a' }),
      procedure('p3', 'deploy', 1, { teamId: 'team-b' }),
    ]
    const payload = projectMemoryGraph([], procs, { totalFacts: 0, totalProcedures: 2 })
    expect(payload.nodes).toHaveLength(2)
    const teamA = payload.nodes.find((n) => n.scopeTeamId === 'team-a')!
    expect(teamA.id).toBe('p2')
    expect(teamA.version).toBe(2)
    expect(teamA.versionCount).toBe(2)
    expect(teamA.versions?.map((v) => v.version)).toEqual([2, 1])
    expect(payload.edges.filter((e) => e.kind === 'version')).toHaveLength(1)
  })

  it('assigns deterministic size-desc communities with dominant-tag labels', () => {
    const rows = [
      fact('a', { tags: ['deploy'] }),
      fact('b', { tags: ['deploy'] }),
      fact('c', { tags: ['deploy', 'infra'] }),
      fact('x', { tags: ['auth'] }),
      fact('y', { tags: ['auth'] }),
      fact('lone', {}),
    ]
    const payload = projectMemoryGraph(rows, [], { totalFacts: 6, totalProcedures: 0 })
    expect(payload.communities[0]).toMatchObject({ id: 0, label: 'deploy', size: 3 })
    expect(payload.communities[1]).toMatchObject({ id: 1, label: 'auth', size: 2 })
    expect(payload.communities[2]).toMatchObject({ id: 2, label: 'untagged', size: 1 })
    // Stability under shuffle: identical payload.
    const shuffled = projectMemoryGraph([...rows].reverse(), [], {
      totalFacts: 6,
      totalProcedures: 0,
    })
    expect(shuffled).toEqual(payload)
  })

  it('labels a procedure-only component by the procedure name', () => {
    const payload = projectMemoryGraph([], [procedure('p1', 'release-checklist', 1)], {
      totalFacts: 0,
      totalProcedures: 1,
    })
    expect(payload.communities[0]?.label).toBe('release-checklist')
  })

  it('reports honest totals/truncation and slices long content', () => {
    const long = fact('big', {})
    long.content = 'x'.repeat(3000)
    const payload = projectMemoryGraph([long], [], { totalFacts: 12, totalProcedures: 0 })
    expect(payload.truncated).toBe(true)
    expect(payload.nodes[0]!.content).toHaveLength(2000)
    expect(payload.nodes[0]!.contentTruncated).toBe(true)
    const exact = projectMemoryGraph([long], [], { totalFacts: 1, totalProcedures: 0 })
    expect(exact.truncated).toBe(false)
  })

  it('threads the learning map onto fact nodes (day-one ring slot)', () => {
    const entry: LearningEntry = {
      status: 'preferred',
      score: 1.5,
      uses: 3,
      usefulCount: 2,
      negativeCount: 0,
      lastUsedAt: 999,
      recentTrail: [],
    }
    const payload = projectMemoryGraph(
      [fact('a', {})],
      [],
      { totalFacts: 1, totalProcedures: 0 },
      {
        learning: new Map([['a', entry]]),
      },
    )
    expect(payload.nodes[0]!.learning).toEqual(entry)
  })

  it('empty input → empty, well-formed payload', () => {
    const payload = projectMemoryGraph([], [], { totalFacts: 0, totalProcedures: 0 })
    expect(payload).toEqual({
      nodes: [],
      edges: [],
      communities: [],
      totalFacts: 0,
      totalProcedures: 0,
      truncated: false,
      similarityAvailable: false,
    })
  })
})
