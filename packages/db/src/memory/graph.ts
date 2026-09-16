// ─── Memory graph projection — pure, deterministic ───────────────────────────
// Synthesizes a graph over the flat memory store: fact↔fact similarity edges
// (cosine over stored embeddings), fact↔fact shared-tag edges (IDF-weighted
// Jaccard with a hub-tag guard, so one ubiquitous tag cannot glue every cluster
// together), procedure version links, and union-find communities with
// dominant-tag labels.
// Two consumers share this module: GET /api/memory/graph (full payload) and
// the auto-injection 1-hop expansion (computeFactEdges + neighborsOf).
//
// Determinism discipline: inputs are sorted by id up front, every selection has
// a total-order tiebreak, and there is no Date.now/Math.random — identical
// inputs always yield identical payloads, so community ids/colors never churn
// between renders of the same data.

import { cosineSimilarity } from './embedding'
import type { LearningEntry } from './learning'
import type { Fact, Procedure } from './types'

/** A fact row with its deserialized embedding — the projection's raw material.
 *  Embeddings are only reachable in-process (never over REST). ArrayLike so a
 *  Float32Array (the store's deserialized form) and plain arrays both fit. */
export interface FactVectorRow extends Fact {
  vector: ArrayLike<number> | null
  embeddingModel: string | null
}

export type MemoryGraphEdgeKind = 'similarity' | 'tag' | 'version'

export interface MemoryFactEdge {
  /** Canonical: `sim:${a}:${b}` | `tag:${a}:${b}` | `ver:${a}:${b}` with a<b. */
  id: string
  source: string
  target: string
  kind: MemoryGraphEdgeKind
  /** similarity: raw cosine (≥ threshold); tag: IDF-weighted Jaccard (0..1]; version: 1. */
  weight: number
  /** Shared non-hub tags (tag edges); [] otherwise. */
  sharedTags: string[]
}

export type MemoryNodeScope = 'global' | 'team' | 'agent'

export interface MemoryGraphNode {
  id: string
  kind: 'fact' | 'procedure'
  title: string
  content: string
  contentTruncated: boolean
  tags: string[]
  scope: MemoryNodeScope
  scopeTeamId: string | null
  scopeAgentId: string | null
  createdByAgentId: string | null
  createdByRuntime: string | null
  sourceTaskId: string | null
  createdAt: number
  updatedAt: number
  degree: number
  community: number
  hasEmbedding: boolean
  version?: number
  versionCount?: number
  versions?: { id: string; version: number; createdAt: number }[]
  learning: LearningEntry | null
}

export interface MemoryGraphCommunity {
  id: number
  label: string
  size: number
}

export interface MemoryGraphPayload {
  nodes: MemoryGraphNode[]
  edges: MemoryFactEdge[]
  communities: MemoryGraphCommunity[]
  /** Pre-cap counts — the UI must say "showing N of M" when truncated. */
  totalFacts: number
  totalProcedures: number
  truncated: boolean
  /** Some embedding-model bucket has ≥2 members (similarity edges possible). */
  similarityAvailable: boolean
}

export interface ComputeFactEdgesOpts {
  /** Raw cosine cutoff. Graph view default 0.6; injection uses 0.8. */
  simThreshold?: number
  /** Per-node cap on similarity edges. */
  simTopK?: number
  /** Per-node cap on tag edges. */
  tagTopK?: number
  /** Hub-tag guard: exclude tags with df ≥ minDf AND df > fraction·N. */
  tagHubMinDf?: number
  tagHubFraction?: number
  /** When set, only vectors from this provider are compared (injection);
   *  unset = any same-model+dims bucket (graph view — old embeddings still link). */
  providerId?: string | null
  /** Optional deterministic per-node degree cap across ALL edges (injection: 6). */
  maxEdgesPerFact?: number
}

const DEFAULTS = {
  simThreshold: 0.6,
  simTopK: 3,
  tagTopK: 4,
  tagHubMinDf: 10,
  tagHubFraction: 0.3,
}

const CONTENT_SLICE = 2000

const byIdAsc = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : 1)

function canonicalEdgeId(kind: MemoryGraphEdgeKind, a: string, b: string): string {
  const prefix = kind === 'similarity' ? 'sim' : kind === 'tag' ? 'tag' : 'ver'
  return a < b ? `${prefix}:${a}:${b}` : `${prefix}:${b}:${a}`
}

function makeEdge(
  kind: MemoryGraphEdgeKind,
  a: string,
  b: string,
  weight: number,
  sharedTags: string[] = [],
): MemoryFactEdge {
  const [source, target] = a < b ? [a, b] : [b, a]
  return { id: canonicalEdgeId(kind, a, b), source, target, kind, weight, sharedTags }
}

/** True when at least one same-model+dims bucket has ≥2 embedded members. */
export function similarityAvailableFor(
  rows: readonly FactVectorRow[],
  providerId?: string | null,
): boolean {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.vector || r.vector.length === 0 || r.embeddingModel == null) continue
    if (providerId != null && r.embeddingModel !== providerId) continue
    const key = `${r.embeddingModel}:${r.vector.length}`
    const n = (counts.get(key) ?? 0) + 1
    if (n >= 2) return true
    counts.set(key, n)
  }
  return false
}

/** Per-node top-K selection over pairwise candidates, then union of survivors.
 *  Candidates per node are sorted (weight desc, other id asc) — deterministic. */
function selectPerNodeTopK(
  candidates: Map<string, { other: string; weight: number; edge: MemoryFactEdge }[]>,
  topK: number,
): Map<string, MemoryFactEdge> {
  const kept = new Map<string, MemoryFactEdge>()
  const nodeIds = [...candidates.keys()].sort()
  for (const nodeId of nodeIds) {
    const list = candidates
      .get(nodeId)!
      .sort((a, b) => b.weight - a.weight || (a.other < b.other ? -1 : 1))
    for (const c of list.slice(0, topK)) kept.set(c.edge.id, c.edge)
  }
  return kept
}

/**
 * Fact↔fact edges: similarity (cosine over same-model embeddings) + shared-tag
 * (IDF-weighted Jaccard). Both kinds may coexist for a pair (different meanings;
 * the renderer offsets curvature).
 */
export function computeFactEdges(
  rows: readonly FactVectorRow[],
  opts: ComputeFactEdgesOpts = {},
): MemoryFactEdge[] {
  const simThreshold = opts.simThreshold ?? DEFAULTS.simThreshold
  const simTopK = opts.simTopK ?? DEFAULTS.simTopK
  const tagTopK = opts.tagTopK ?? DEFAULTS.tagTopK
  const tagHubMinDf = opts.tagHubMinDf ?? DEFAULTS.tagHubMinDf
  const tagHubFraction = opts.tagHubFraction ?? DEFAULTS.tagHubFraction

  const facts = [...rows].sort(byIdAsc) // input-order invariance

  // ── Similarity edges: bucket by model+dims; cross-model never compared. ──
  const buckets = new Map<string, FactVectorRow[]>()
  for (const r of facts) {
    if (!r.vector || r.vector.length === 0 || r.embeddingModel == null) continue
    if (opts.providerId != null && r.embeddingModel !== opts.providerId) continue
    const key = `${r.embeddingModel}:${r.vector.length}`
    const list = buckets.get(key)
    if (list) list.push(r)
    else buckets.set(key, [r])
  }
  const simCandidates = new Map<string, { other: string; weight: number; edge: MemoryFactEdge }[]>()
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!
        const b = bucket[j]!
        const cos = cosineSimilarity(a.vector!, b.vector!)
        if (cos < simThreshold) continue
        const edge = makeEdge('similarity', a.id, b.id, cos)
        const pushTo = (id: string, other: string) => {
          const list = simCandidates.get(id)
          const item = { other, weight: cos, edge }
          if (list) list.push(item)
          else simCandidates.set(id, [item])
        }
        pushTo(a.id, b.id)
        pushTo(b.id, a.id)
      }
    }
  }
  const simEdges = selectPerNodeTopK(simCandidates, simTopK)

  // ── Tag edges: IDF-weighted Jaccard over non-hub tags. ──
  const df = new Map<string, number>()
  for (const f of facts) {
    for (const t of new Set(f.tags)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const isHub = (t: string): boolean => {
    const d = df.get(t) ?? 0
    return d >= tagHubMinDf && d > tagHubFraction * facts.length
  }
  const nonHubTags = (f: Fact): string[] => [...new Set(f.tags)].filter((t) => !isHub(t))

  const posting = new Map<string, FactVectorRow[]>() // non-hub tag → facts
  for (const f of facts) {
    for (const t of nonHubTags(f)) {
      const list = posting.get(t)
      if (list) list.push(f)
      else posting.set(t, [f])
    }
  }
  const pairWeights = new Map<string, { a: FactVectorRow; b: FactVectorRow }>()
  for (const list of posting.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!
        const b = list[j]!
        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`
        if (!pairWeights.has(key)) pairWeights.set(key, { a, b })
      }
    }
  }
  const idf = (t: string): number => 1 / (df.get(t) ?? 1)
  const tagCandidates = new Map<string, { other: string; weight: number; edge: MemoryFactEdge }[]>()
  for (const { a, b } of pairWeights.values()) {
    const tagsA = nonHubTags(a)
    const tagsB = new Set(nonHubTags(b))
    const shared = tagsA.filter((t) => tagsB.has(t)).sort()
    if (shared.length === 0) continue
    const union = new Set([...tagsA, ...tagsB])
    let sharedSum = 0
    for (const t of shared) sharedSum += idf(t)
    let unionSum = 0
    for (const t of union) unionSum += idf(t)
    const weight = unionSum > 0 ? sharedSum / unionSum : 0
    if (weight <= 0) continue
    const edge = makeEdge('tag', a.id, b.id, weight, shared)
    const pushTo = (id: string, other: string) => {
      const list = tagCandidates.get(id)
      const item = { other, weight, edge }
      if (list) list.push(item)
      else tagCandidates.set(id, [item])
    }
    pushTo(a.id, b.id)
    pushTo(b.id, a.id)
  }
  const tagEdges = selectPerNodeTopK(tagCandidates, tagTopK)

  let edges = [...simEdges.values(), ...tagEdges.values()].sort(
    (a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1),
  )

  // ── Optional deterministic per-node degree cap (injection's hub guard). ──
  if (opts.maxEdgesPerFact != null) {
    const cap = opts.maxEdgesPerFact
    const degree = new Map<string, number>()
    edges = edges.filter((e) => {
      const ds = degree.get(e.source) ?? 0
      const dt = degree.get(e.target) ?? 0
      if (ds >= cap || dt >= cap) return false
      degree.set(e.source, ds + 1)
      degree.set(e.target, dt + 1)
      return true
    })
  }

  return edges
}

/**
 * Hub-avoiding 1-hop expansion: neighbors of the
 * seeds, excluding any neighbor whose degree exceeds degreeCap unless it is
 * itself a seed, and excluding the seeds themselves. Returns neighborId → best
 * incident edge weight + the seed it connects through, in (weight desc, id asc)
 * iteration order.
 */
export function neighborsOf(
  seedIds: readonly string[],
  edges: readonly MemoryFactEdge[],
  opts: { degreeCap?: number } = {},
): Map<string, { weight: number; via: string }> {
  const degreeCap = opts.degreeCap ?? 8
  const seeds = new Set(seedIds)
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  const best = new Map<string, { weight: number; via: string }>()
  const sorted = [...edges].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
  for (const e of sorted) {
    for (const [from, to] of [
      [e.source, e.target],
      [e.target, e.source],
    ] as const) {
      if (!seeds.has(from) || seeds.has(to)) continue
      if ((degree.get(to) ?? 0) > degreeCap) continue // hub — visited, not expanded
      const prev = best.get(to)
      if (!prev || e.weight > prev.weight) best.set(to, { weight: e.weight, via: from })
    }
  }
  const entries = [...best.entries()].sort(
    (a, b) => b[1].weight - a[1].weight || (a[0] < b[0] ? -1 : 1),
  )
  return new Map(entries)
}

// ─── Union-find (deterministic connected components) ─────────────────────────

class UnionFind {
  private parent = new Map<string, string>()

  find(x: string): string {
    let root = this.parent.get(x) ?? x
    while (root !== (this.parent.get(root) ?? root)) root = this.parent.get(root) ?? root
    // Path compression
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur) ?? cur
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    // Deterministic: smaller id becomes root.
    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }
}

export interface ProjectMemoryGraphOpts extends ComputeFactEdgesOpts {
  /** Per-fact learning entries (WS-B); absent → all nodes carry learning: null. */
  learning?: Map<string, LearningEntry>
}

/**
 * The full graph payload for GET /api/memory/graph: collapsed procedure nodes,
 * synthesized edges, degrees, deterministic communities, honesty fields.
 */
export function projectMemoryGraph(
  facts: readonly FactVectorRow[],
  procedures: readonly Procedure[],
  totals: { totalFacts: number; totalProcedures: number },
  opts: ProjectMemoryGraphOpts = {},
): MemoryGraphPayload {
  const sortedFacts = [...facts].sort(byIdAsc)

  // ── Procedure collapse: latest version per (name, scope). ──
  const groups = new Map<string, Procedure[]>()
  for (const p of [...procedures].sort(byIdAsc)) {
    const key = `${p.name} ${p.scopeTeamId ?? ''} ${p.scopeAgentId ?? ''}`
    const list = groups.get(key)
    if (list) list.push(p)
    else groups.set(key, [p])
  }
  const collapsed: { survivor: Procedure; versions: Procedure[] }[] = []
  for (const list of groups.values()) {
    const versionsDesc = [...list].sort((a, b) => b.version - a.version || byIdAsc(a, b))
    collapsed.push({ survivor: versionsDesc[0]!, versions: versionsDesc })
  }
  collapsed.sort((a, b) => byIdAsc(a.survivor, b.survivor))

  // ── Edges. ──
  const factEdges = computeFactEdges(sortedFacts, opts)
  // Version edges: collapsed procedures sharing a name across scope keys.
  const byName = new Map<string, Procedure[]>()
  for (const { survivor } of collapsed) {
    const list = byName.get(survivor.name)
    if (list) list.push(survivor)
    else byName.set(survivor.name, [survivor])
  }
  const versionEdges: MemoryFactEdge[] = []
  for (const list of byName.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort(byIdAsc)
    for (let i = 0; i < sorted.length - 1; i++) {
      versionEdges.push(makeEdge('version', sorted[i]!.id, sorted[i + 1]!.id, 1))
    }
  }
  const edges = [...factEdges, ...versionEdges]

  // ── Degree. ──
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }

  // ── Communities: union-find components, size-desc stable ids. ──
  const uf = new UnionFind()
  const allIds = [...sortedFacts.map((f) => f.id), ...collapsed.map(({ survivor }) => survivor.id)]
  for (const e of edges) uf.union(e.source, e.target)
  const components = new Map<string, string[]>()
  for (const id of allIds) {
    const root = uf.find(id)
    const list = components.get(root)
    if (list) list.push(id)
    else components.set(root, [id])
  }
  const componentList = [...components.values()]
    .map((members) => members.sort())
    .sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1))
  const communityOf = new Map<string, number>()
  componentList.forEach((members, idx) => {
    for (const m of members) communityOf.set(m, idx)
  })

  // Labels: dominant tag among member facts; procedure-only → first procedure
  // name; no tags at all → 'untagged'.
  const factById = new Map(sortedFacts.map((f) => [f.id, f]))
  const procById = new Map(collapsed.map(({ survivor }) => [survivor.id, survivor]))
  const communities: MemoryGraphCommunity[] = componentList.map((members, idx) => {
    const tagCounts = new Map<string, number>()
    for (const m of members) {
      const f = factById.get(m)
      if (!f) continue
      for (const t of new Set(f.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
    }
    let label: string | null = null
    let bestCount = 0
    for (const [t, n] of [...tagCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n > bestCount) {
        label = t
        bestCount = n
      }
    }
    if (label === null) {
      const firstProc = members.map((m) => procById.get(m)).find((p) => p != null)
      label = firstProc ? firstProc.name : 'untagged'
    }
    return { id: idx, label, size: members.length }
  })

  // ── Nodes. ──
  const learningOf = (id: string): LearningEntry | null => opts.learning?.get(id) ?? null
  const scopeOf = (agentId: string | null, teamId: string | null): MemoryNodeScope =>
    agentId ? 'agent' : teamId ? 'team' : 'global'

  const nodes: MemoryGraphNode[] = [
    ...sortedFacts.map((f): MemoryGraphNode => ({
      id: f.id,
      kind: 'fact',
      title: f.title,
      content: f.content.slice(0, CONTENT_SLICE),
      contentTruncated: f.content.length > CONTENT_SLICE,
      tags: f.tags,
      scope: scopeOf(f.scopeAgentId, f.scopeTeamId),
      scopeTeamId: f.scopeTeamId,
      scopeAgentId: f.scopeAgentId,
      createdByAgentId: f.createdByAgentId,
      createdByRuntime: f.createdByRuntime,
      sourceTaskId: f.sourceTaskId,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      degree: degree.get(f.id) ?? 0,
      community: communityOf.get(f.id) ?? 0,
      hasEmbedding: f.vector != null && f.vector.length > 0,
      learning: learningOf(f.id),
    })),
    ...collapsed.map(({ survivor, versions }): MemoryGraphNode => ({
      id: survivor.id,
      kind: 'procedure',
      title: survivor.name,
      content: survivor.content.slice(0, CONTENT_SLICE),
      contentTruncated: survivor.content.length > CONTENT_SLICE,
      tags: [],
      scope: scopeOf(survivor.scopeAgentId, survivor.scopeTeamId),
      scopeTeamId: survivor.scopeTeamId,
      scopeAgentId: survivor.scopeAgentId,
      createdByAgentId: survivor.createdByAgentId,
      createdByRuntime: survivor.createdByRuntime,
      sourceTaskId: survivor.sourceTaskId,
      createdAt: survivor.createdAt,
      updatedAt: survivor.createdAt,
      degree: degree.get(survivor.id) ?? 0,
      community: communityOf.get(survivor.id) ?? 0,
      hasEmbedding: false,
      version: survivor.version,
      versionCount: versions.length,
      versions: versions
        .slice(0, 10)
        .map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt })),
      learning: null, // outcomes are fact-only in v1
    })),
  ]

  return {
    nodes,
    edges,
    communities,
    totalFacts: totals.totalFacts,
    totalProcedures: totals.totalProcedures,
    truncated: totals.totalFacts > sortedFacts.length || totals.totalProcedures > collapsed.length,
    similarityAvailable: similarityAvailableFor(sortedFacts, opts.providerId),
  }
}
