// Thin typed wrapper over the memory REST surface (apps/web/server/api/memory.ts).
// Mirrors the defensive `boardClient` pattern: every call is
// best-effort and resolves to a safe empty/null value on network/parse failure,
// never throwing to the caller. The SPA never imports server packages, so the
// shapes are mirrored locally here.

import { apiFetch, consumeApiSSE, type SSEEvent } from '@clawboo/control-client'

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
  /** No vector because the provider turned this fact down. */
  embedSkipped?: boolean
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

/** Why embeddings are, or are not, working. Mirrors the server's EmbeddingStatus. */
export interface EmbeddingStatus {
  /** `ready` is the only state with a provider. `ollama-model-missing`: Ollama
   *  runs without the model. `ollama-unreachable`: the store is indexed locally
   *  and Ollama is not answering, so nothing falls back to a cloud provider. */
  state: 'ready' | 'disabled' | 'ollama-model-missing' | 'ollama-unreachable' | 'none'
  provider: EmbeddingProviderInfo | null
  /** The provider sends fact text off this machine. */
  remote: boolean
  /** A model whose install is a real fix: nothing can embed without it, or it
   *  would move embeddings from a remote provider onto this machine. */
  missingModel: string | null
  /** An OpenAI key exists that local-first is deliberately not using. */
  remoteAvailable: boolean
  /** Facts waiting to be indexed; null with no provider. */
  pending: number | null
  /** Every fact in the store: the scale of what switching to OpenAI sends. */
  factCount: number
  /** The store has had local vectors, so a remote provider serving means the
   *  user chose it for an Ollama outage. */
  localFirst: boolean
  /** Vectors written by indexing since the server started; only grows. */
  vectorsWritten: number
  /** Facts the provider turned down (they still match by keyword). */
  skipped: number
  indexing: boolean
  installing: boolean
  lastError: string | null
}

/** Fields a server from before they existed leaves out. */
function normalizeStatus(s: EmbeddingStatus): EmbeddingStatus {
  return {
    ...s,
    factCount: s.factCount ?? 0,
    localFirst: s.localFirst ?? false,
    vectorsWritten: s.vectorsWritten ?? 0,
  }
}

/** GET /api/memory/provider's `status`. Null when the request fails, which the
 *  UI treats as "unknown", never as "no provider". */
export async function getEmbeddingStatus(): Promise<EmbeddingStatus | null> {
  try {
    const r = await apiFetch('/api/memory/provider')
    if (!r.ok) return null
    const body = (await r.json()) as {
      provider?: EmbeddingProviderInfo | null
      status?: EmbeddingStatus
    }
    if (body.status) return normalizeStatus(body.status)
    // A server from before `status` existed reports only the provider.
    if (body.provider === undefined) return null
    return {
      state: body.provider ? 'ready' : 'none',
      provider: body.provider,
      remote: body.provider?.id.startsWith('openai:') ?? false,
      missingModel: null,
      remoteAvailable: false,
      pending: null,
      factCount: 0,
      localFirst: false,
      vectorsWritten: 0,
      skipped: 0,
      indexing: false,
      installing: false,
      lastError: null,
    }
  } catch {
    return null
  }
}

/** POST /api/memory/embedding/reindex: re-probe, check the provider, and index
 *  what is missing. `allowRemote` records the choice to use OpenAI while a
 *  locally indexed store's Ollama is down (it lasts until Ollama serves again);
 *  `reembedAll` also replaces vectors another provider produced. */
export async function reindexEmbeddings(
  opts: { allowRemote?: boolean; reembedAll?: boolean } = {},
): Promise<EmbeddingStatus | null> {
  try {
    const r = await apiFetch('/api/memory/embedding/reindex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    })
    if (!r.ok) return null
    const body = (await r.json()) as { status?: EmbeddingStatus }
    return body.status ? normalizeStatus(body.status) : null
  } catch {
    return null
  }
}

export interface InstallProgress {
  message: string
  /** 0..1, present only while the model itself is downloading. */
  fraction: number | null
}

/** POST /api/memory/embedding/install (SSE). Returns the stream's controller so
 *  the caller can cancel. `onDone` also fires when there turned out to be
 *  nothing to install (another window finished it), which is not a failure. */
export function installEmbeddingModel(handlers: {
  onProgress: (p: InstallProgress) => void
  onDone: (status: EmbeddingStatus | null) => void
  /** Another install is already running; wait for it. */
  onBusy: () => void
  onError: (message: string) => void
}): AbortController {
  let settled = false
  const settle = (fn: () => void) => {
    if (settled) return
    settled = true
    fn()
  }
  return consumeApiSSE(
    '/api/memory/embedding/install',
    { method: 'POST' },
    {
      onProgress: (e: SSEEvent) => {
        const total = typeof e['total'] === 'number' ? e['total'] : null
        const completed = typeof e['completed'] === 'number' ? e['completed'] : null
        handlers.onProgress({
          message: typeof e.message === 'string' ? e.message : '',
          fraction: total && completed != null ? Math.min(1, completed / total) : null,
        })
      },
      onComplete: (e: SSEEvent) =>
        settle(() => handlers.onDone((e['status'] as EmbeddingStatus | undefined) ?? null)),
      onError: (e: SSEEvent) =>
        settle(() => {
          if (e.code === 'HTTP_409') handlers.onDone(null)
          else if (e.code === 'IN_PROGRESS') handlers.onBusy()
          else if (e.code === 'HTTP_429')
            handlers.onError('Too many attempts. Try again in a minute.')
          else handlers.onError(typeof e.message === 'string' ? e.message : 'install failed')
        }),
    },
  )
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
