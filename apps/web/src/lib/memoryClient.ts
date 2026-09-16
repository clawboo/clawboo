// Thin typed wrapper over the memory REST surface (apps/web/server/api/memory.ts).
// Mirrors the defensive `boardClient` pattern: every call is
// best-effort and resolves to a safe empty/null value on network/parse failure,
// never throwing to the caller. The SPA never imports server packages, so the
// shapes are mirrored locally here.

import { apiFetch } from '@clawboo/control-client'

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

export type SearchMode = 'fts' | 'vector' | 'hybrid'

export interface MemoryFact {
  id: string
  title: string
  content: string
  tags: string[]
  scopeAgentId: string | null
  scopeTeamId: string | null
  tenantId: string | null
  /** Provenance — who/what produced the row (null on rows saved before v2). */
  createdByAgentId: string | null
  createdByRuntime: string | null
  sourceTaskId: string | null
  sourceSessionKey: string | null
  createdAt: number
  updatedAt: number
}

// ─── Learning overlay (mirrors packages/db/src/memory/learning.ts) ───────────

export type LearningStatus = 'preferred' | 'tentative' | 'contested' | 'dead_end'

export type OutcomeKind = 'useful' | 'dead_end' | 'corrected' | 'cited'

export interface LearningTrailItem {
  kind: OutcomeKind
  createdAt: number
  agentId: string | null
  taskId: string | null
  runtime: string | null
  note: string | null
}

/** Derived per-fact learning entry (outcome-scored overlay; never mutates facts).
 *  Graph ring mapping (MemoryFactNode): preferred → mint solid; tentative →
 *  mint dotted; contested → amber solid; dead_end → gray dashed; null → none. */
export interface LearningEntry {
  /** null = no scored signals (cited-only, or nothing). */
  status: LearningStatus | null
  /** Present ONLY when status === 'contested'. */
  verdict?: 'useful' | 'avoid'
  score: number
  /** ALL signals including 'cited' — honest usage frequency, not endorsement. */
  uses: number
  usefulCount: number
  negativeCount: number
  lastUsedAt: number | null
  recentTrail: LearningTrailItem[]
}

export interface MemoryOutcome {
  id: string
  factId: string
  outcome: OutcomeKind
  note: string | null
  agentId: string | null
  teamId: string | null
  taskId: string | null
  runtime: string | null
  createdAt: number
}

// ─── Memory graph (mirrors packages/db/src/memory/graph.ts) ──────────────────

export type MemoryGraphEdgeKind = 'similarity' | 'tag' | 'version'

export interface MemoryGraphEdge {
  /** Canonical: `sim:${a}:${b}` | `tag:${a}:${b}` | `ver:${a}:${b}` with a<b. */
  id: string
  source: string
  target: string
  kind: MemoryGraphEdgeKind
  /** similarity: raw cosine; tag: IDF-weighted Jaccard (0..1]; version: 1. */
  weight: number
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
  edges: MemoryGraphEdge[]
  communities: MemoryGraphCommunity[]
  /** Pre-cap counts — the UI must say "showing N of M" when truncated. */
  totalFacts: number
  totalProcedures: number
  truncated: boolean
  similarityAvailable: boolean
}

export interface MemoryProcedure {
  id: string
  name: string
  version: number
  content: string
  scopeAgentId: string | null
  scopeTeamId: string | null
  tenantId: string | null
  createdAt: number
}

export interface MemorySearchResult extends MemoryFact {
  score: number
  matchedVia: SearchMode
  /** Merged client-side from the response's sibling learning map. */
  learning?: LearningEntry | null
}

export interface EmbeddingProviderInfo {
  id: string
  dimensions: number
}

export interface SearchOpts {
  limit?: number
  teamId?: string
  agentId?: string
}

/** GET /api/memory — search (fts | vector | hybrid). */
export async function searchMemory(
  query: string,
  mode: SearchMode,
  opts: SearchOpts = {},
): Promise<MemorySearchResult[]> {
  try {
    const p = new URLSearchParams({ query, mode })
    if (opts.limit) p.set('limit', String(opts.limit))
    if (opts.teamId) p.set('teamId', opts.teamId)
    if (opts.agentId) p.set('agentId', opts.agentId)
    const r = await apiFetch(`/api/memory?${p.toString()}`)
    if (!r.ok) return []
    const body = (await r.json()) as {
      results?: MemorySearchResult[]
      learning?: Record<string, LearningEntry>
    }
    const learning = body.learning ?? {}
    // Merge the sibling learning map in client-side so callers keep their
    // plain-array handling (additive — absent map ⇒ entries stay undefined).
    return (body.results ?? []).map((res) =>
      res.id in learning ? { ...res, learning: learning[res.id] ?? null } : res,
    )
  } catch {
    return []
  }
}

export interface SaveFactInput {
  title: string
  content: string
  tags?: string[]
}

/** POST /api/memory — save a declarative fact. Returns the saved fact or null. */
export async function saveFact(input: SaveFactInput): Promise<MemoryFact | null> {
  try {
    const r = await apiFetch('/api/memory', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: 'fact', ...input }),
    })
    if (!r.ok) return null
    const body = (await r.json()) as { fact?: MemoryFact }
    return body.fact ?? null
  } catch {
    return null
  }
}

export interface BrowseResult {
  facts: MemoryFact[]
  procedures: MemoryProcedure[]
  /** Per-fact learning overlay keyed by fact id (additive; {} when absent). */
  learning: Record<string, LearningEntry>
  /** False on a network/non-2xx failure — lets the panel show an error/retry
   *  instead of an empty browse that's indistinguishable from a fresh store. */
  ok: boolean
}

/** GET /api/memory/browse — the two-tier browse (declarative facts + procedures). */
export async function browseMemory(opts: SearchOpts = {}): Promise<BrowseResult> {
  try {
    const p = new URLSearchParams()
    if (opts.limit) p.set('limit', String(opts.limit))
    if (opts.teamId) p.set('teamId', opts.teamId)
    if (opts.agentId) p.set('agentId', opts.agentId)
    const qs = p.toString()
    const r = await apiFetch(`/api/memory/browse${qs ? `?${qs}` : ''}`)
    if (!r.ok) return { facts: [], procedures: [], learning: {}, ok: false }
    const body = (await r.json()) as {
      facts?: MemoryFact[]
      procedures?: MemoryProcedure[]
      learning?: Record<string, LearningEntry>
    }
    return {
      facts: body.facts ?? [],
      procedures: body.procedures ?? [],
      learning: body.learning ?? {},
      ok: true,
    }
  } catch {
    return { facts: [], procedures: [], learning: {}, ok: false }
  }
}

/** GET /api/memory/provider — the active embedding provider (null = FTS-only). */
export async function getProvider(): Promise<EmbeddingProviderInfo | null> {
  try {
    const r = await apiFetch('/api/memory/provider')
    if (!r.ok) return null
    const body = (await r.json()) as { provider?: EmbeddingProviderInfo | null }
    return body.provider ?? null
  } catch {
    return null
  }
}

export interface MemoryGraphResult {
  graph: MemoryGraphPayload
  provider: EmbeddingProviderInfo | null
}

/** GET /api/memory/graph — the projected memory graph. Null on any failure so
 *  the view renders an error + Retry instead of a silently-empty canvas. */
export async function fetchMemoryGraph(opts: SearchOpts = {}): Promise<MemoryGraphResult | null> {
  try {
    const p = new URLSearchParams()
    if (opts.limit) p.set('limit', String(opts.limit))
    if (opts.teamId) p.set('teamId', opts.teamId)
    if (opts.agentId) p.set('agentId', opts.agentId)
    const qs = p.toString()
    const r = await apiFetch(`/api/memory/graph${qs ? `?${qs}` : ''}`)
    if (!r.ok) return null
    const body = (await r.json()) as {
      ok?: boolean
      graph?: MemoryGraphPayload
      provider?: EmbeddingProviderInfo | null
    }
    if (!body.graph) return null
    return { graph: body.graph, provider: body.provider ?? null }
  } catch {
    return null
  }
}

/** POST /api/memory/feedback — report a fact outcome ('cited' is internal-only
 *  and not accepted here). Returns the updated learning entry, null on failure. */
export async function recordFeedback(
  factId: string,
  outcome: 'useful' | 'dead_end' | 'corrected',
  note?: string,
): Promise<LearningEntry | null> {
  try {
    const r = await apiFetch('/api/memory/feedback', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ factId, outcome, ...(note ? { note } : {}) }),
    })
    if (!r.ok) return null
    const body = (await r.json()) as { learning?: LearningEntry | null }
    return body.learning ?? null
  } catch {
    return null
  }
}

/** GET /api/memory/outcomes?factId= — the full outcome trail, newest-first. */
export async function getOutcomes(factId: string): Promise<MemoryOutcome[]> {
  try {
    const p = new URLSearchParams({ factId })
    const r = await apiFetch(`/api/memory/outcomes?${p.toString()}`)
    if (!r.ok) return []
    const body = (await r.json()) as { outcomes?: MemoryOutcome[] }
    return body.outcomes ?? []
  } catch {
    return []
  }
}
