// Thin typed wrapper over the memory REST surface (apps/web/server/api/memory.ts).
// Mirrors the defensive `boardClient` pattern: every call is
// best-effort and resolves to a safe empty/null value on network/parse failure,
// never throwing to the caller. The SPA never imports server packages, so the
// shapes are mirrored locally here.

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
  createdAt: number
  updatedAt: number
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
    const r = await fetch(`/api/memory?${p.toString()}`)
    if (!r.ok) return []
    const body = (await r.json()) as { results?: MemorySearchResult[] }
    return body.results ?? []
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
    const r = await fetch('/api/memory', {
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
    const r = await fetch(`/api/memory/browse${qs ? `?${qs}` : ''}`)
    if (!r.ok) return { facts: [], procedures: [], ok: false }
    const body = (await r.json()) as { facts?: MemoryFact[]; procedures?: MemoryProcedure[] }
    return { facts: body.facts ?? [], procedures: body.procedures ?? [], ok: true }
  } catch {
    return { facts: [], procedures: [], ok: false }
  }
}

/** GET /api/memory/provider — the active embedding provider (null = FTS-only). */
export async function getProvider(): Promise<EmbeddingProviderInfo | null> {
  try {
    const r = await fetch('/api/memory/provider')
    if (!r.ok) return null
    const body = (await r.json()) as { provider?: EmbeddingProviderInfo | null }
    return body.provider ?? null
  } catch {
    return null
  }
}
