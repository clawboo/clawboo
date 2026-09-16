// ─── Memory store — types + the swappable interface ─────────────────────────
// 2-tier memory (declarative facts + versioned procedures) with FTS5 + an
// optional vector index. The `MemoryStore` interface is the seam a future
// hosted/enterprise backend (Postgres / vector DB / knowledge-graph) drops into;
// `EmbeddingProvider` is the seam the embedding source drops into. The default
// SqliteMemoryStore (FTS5 + brute-force-cosine over a BLOB column) is the
// local-first implementation.

/** Scope a fact/procedure to a team and/or agent (+ a dormant tenant seam). */
export interface MemoryScope {
  agentId?: string | null
  teamId?: string | null
  tenantId?: string | null
}

/** Who/what produced a memory row. Server-authored only — never model-supplied.
 *  Distinct from the visibility scope: a bound MCP save drops agentId from the
 *  SCOPE (team-shared recall) but records it here, so "who saved this" is
 *  legible without narrowing who can recall it. */
export interface MemoryProvenance {
  agentId?: string | null
  runtime?: string | null // runtime id, or 'user' for UI saves
  taskId?: string | null
  sessionKey?: string | null
}

/** A durable declarative fact ("User prefers concise responses"). */
export interface Fact {
  id: string
  title: string
  content: string
  tags: string[]
  scopeAgentId: string | null
  scopeTeamId: string | null
  tenantId: string | null
  createdByAgentId: string | null
  createdByRuntime: string | null
  sourceTaskId: string | null
  sourceSessionKey: string | null
  createdAt: number
  updatedAt: number
}

/** A versioned SKILL-style procedure (the "how", kept out of facts). */
export interface Procedure {
  id: string
  name: string
  version: number
  content: string
  scopeAgentId: string | null
  scopeTeamId: string | null
  tenantId: string | null
  createdByAgentId: string | null
  createdByRuntime: string | null
  sourceTaskId: string | null
  sourceSessionKey: string | null
  createdAt: number
}

/** An outcome signal against a fact. 'useful'/'dead_end'/'corrected' are
 *  explicit feedback (agents via memory_feedback, users via the UI); 'cited' is
 *  INTERNAL-ONLY — written by the auto-injection path when a fact enters a run's
 *  prompt, so usage frequency is real data without fake endorsement semantics.
 *  External write surfaces (REST/MCP zod enums) deliberately exclude 'cited'. */
export type OutcomeKind = 'useful' | 'dead_end' | 'corrected' | 'cited'

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

export interface RecordOutcomeInput {
  factId: string // FULL id (callers resolve prefixes via getFact first)
  outcome: OutcomeKind
  note?: string | null
  agentId?: string | null
  teamId?: string | null
  taskId?: string | null
  runtime?: string | null
}

export type SearchMode = 'fts' | 'vector' | 'hybrid'

/** A fact returned by search, annotated with how it matched + a 0..1 score. */
export interface MemorySearchResult extends Fact {
  score: number
  matchedVia: SearchMode
}

export interface SaveFactInput {
  title: string
  content: string
  tags?: string[]
  scope?: MemoryScope
  provenance?: MemoryProvenance
}

export interface SaveProcedureInput {
  name: string
  content: string
  scope?: MemoryScope
  provenance?: MemoryProvenance
}

export interface SearchOpts {
  mode?: SearchMode
  limit?: number
  scope?: MemoryScope
}

export interface BrowseOpts {
  limit?: number
  scope?: MemoryScope
}

/**
 * The swappable persistence + retrieval interface. Methods are async because an
 * `EmbeddingProvider` may be a network call (Ollama/OpenAI) — memory is not in
 * the hot board-claim contention path, so async is acceptable. Vector/hybrid
 * modes gracefully fall back to FTS when no embedding provider is configured.
 */
export interface MemoryStore {
  saveFact(input: SaveFactInput): Promise<Fact>
  searchMemory(query: string, opts?: SearchOpts): Promise<MemorySearchResult[]>
  browseMemory(opts?: BrowseOpts): Promise<Fact[]>
  saveProcedure(input: SaveProcedureInput): Promise<Procedure>
  getProcedure(name: string, scope?: MemoryScope): Promise<Procedure | null>
  listProcedures(opts?: BrowseOpts): Promise<Procedure[]>
  /** Exact-id lookup, falling back to an 8+ char hex/hyphen prefix (unique match
   *  only). Scope-filtered — a fact invisible to the caller's scope resolves to
   *  null, so feedback cannot probe cross-team existence. */
  getFact(idOrPrefix: string, scope?: MemoryScope): Promise<Fact | null>
  recordOutcome(input: RecordOutcomeInput): Promise<MemoryOutcome>
  listOutcomes(opts?: { factIds?: string[]; limit?: number }): Promise<MemoryOutcome[]>
}

/**
 * The embedding source. `dimensions` is a declared hint; cosine only requires
 * equal-length vectors, so a provider that returns a different length than
 * stored vectors is simply skipped (guarded in the store).
 */
export interface EmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}
