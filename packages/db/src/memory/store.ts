// ─── SqliteMemoryStore — the local-first MemoryStore implementation ──────────
// FTS5 (always available) + an optional vector index (brute-force cosine over a
// Float32 BLOB column) + a hybrid blend. Reuses the board's write-contention
// recipe. Embedding is best-effort: if the provider errors or is absent, facts
// still save (no vector) and vector/hybrid search degrades to FTS.

import { randomUUID } from 'node:crypto'

import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'

import { immediateWrite, withWriteRetry } from '../board/contention'
import { scrubSecrets } from '../tools/scrub'
import { getSetting, setSetting, type ClawbooDb } from '../db'
import {
  memoryFacts,
  memoryOutcomes,
  memoryProcedures,
  type DbMemoryFact,
  type DbMemoryFactInsert,
  type DbMemoryOutcome,
  type DbMemoryProcedure,
} from '../schema'
import {
  cosineSimilarity,
  deserializeEmbedding,
  isRequestShapedEmbeddingError,
  LOCAL_FIRST_SETTING,
  REMOTE_EMBEDDING_CONSENT_SETTING,
  serializeEmbedding,
} from './embedding'
import {
  projectMemoryGraph,
  type FactVectorRow,
  type MemoryGraphPayload,
  type ProjectMemoryGraphOpts,
} from './graph'
import { computeLearningOverlay, type LearningEntry } from './learning'
import type {
  BrowseOpts,
  EmbeddingProvider,
  Fact,
  MemoryOutcome,
  MemoryScope,
  MemorySearchResult,
  MemoryStore,
  Procedure,
  RecordOutcomeInput,
  SaveFactInput,
  SaveProcedureInput,
  SearchMode,
  SearchOpts,
} from './types'

const DEFAULT_LIMIT = 10
const FTS_CANDIDATE_CAP = 200 // vector candidate pool / fts match cap
const MAX_GRAPH_FACTS = 500 // newest-first cap on the graph payload (honest: truncated flag)
const MAX_GRAPH_PROCEDURES = 200 // raw procedure rows loaded pre-collapse
const LEARNING_OUTCOMES_PER_FACT_CAP = 200 // per-fact window in learningForFacts (explicit feedback ranks first)

/** Longest text sent for one fact. OpenAI rejects a whole request when any
 *  input passes 8192 tokens, and the REST save allows 50,000 characters (the
 *  MCP save has no limit). A fact's opening 8000 characters carry its meaning;
 *  the full text is still stored and still matched by keyword. */
export const EMBED_TEXT_MAX_CHARS = 8000

/** The shorter prefix tried when a provider turns one fact down. Characters are
 *  only a proxy for tokens: CJK text runs about a token per character and some
 *  scripts several, so 8000 characters can still pass OpenAI's limit. */
export const EMBED_TEXT_RETRY_CHARS = 2000

/** The text a fact is embedded from. Save and backfill must agree on it, or a
 *  backfilled vector would not be comparable with a freshly saved one. */
export function factEmbeddingText(title: string, content: string): string {
  const text = `${title}\n${content}`
  return text.length > EMBED_TEXT_MAX_CHARS ? text.slice(0, EMBED_TEXT_MAX_CHARS) : text
}

/** What one backfill pass did. `remaining` is re-counted after the pass, so it
 *  also reflects facts saved concurrently by another writer. */
export interface BackfillEmbeddingsResult {
  embedded: number
  /** Facts the provider rejected on their own. The caller should exclude them
   *  from later passes, or the same rejection is paid for every time. */
  skipped: string[]
  remaining: number
  /** Why the pass stopped early, or null when it ran out of work. */
  error: string | null
}

export interface BackfillEmbeddingsOpts {
  batchSize?: number
  maxFacts?: number
  signal?: AbortSignal
  /**
   * Also replace vectors a different provider produced. Default true. The
   * server passes false for a remote provider: indexing a fact that has no
   * vector is what the user asked for by connecting one, but silently shipping
   * every already-indexed fact to a cloud API is not.
   */
  reembedOtherModels?: boolean
  /** Facts to leave alone this pass, typically ones an earlier pass skipped. */
  skipIds?: readonly string[]
}

const BACKFILL_BATCH = 32

interface BackfillRow {
  id: string
  title: string
  content: string
  createdAt: number
}

// A fact needs a vector when it has none, or (optionally) one from a provider
// other than the current one: cosine across models is meaningless. Every writer
// sets `embedding` and `embedding_model` together (both or neither), so the
// model column alone says whether a vector exists, and its index serves this.
function needsEmbedding(providerId: string, includeOtherModels: boolean) {
  const missing = sql`${memoryFacts.embeddingModel} IS NULL`
  return includeOtherModels
    ? sql`(${missing} OR ${memoryFacts.embeddingModel} != ${providerId})`
    : missing
}

function eqOrNull<T>(col: Parameters<typeof eq>[0], val: T | null | undefined) {
  return val == null ? isNull(col) : eq(col, val as never)
}

/** Treat an empty-string scope tag as null (global) on the PROCEDURE point-lookup
 *  path — so `''` and an absent tag both address the global procedure. Keeps
 *  save/get consistent with each other AND with listProcedures' `provided`-based
 *  scoping, which already collapses `''` to the global (null) set. (Facts use a
 *  different `''`=global-only-read sentinel and are intentionally NOT normalized.) */
function emptyToNull(v: string | null | undefined): string | null {
  return v == null || v === '' ? null : v
}

/** A scope tag is PROVIDED when it is present at all, INCLUDING an empty string.
 *  A provided team/agent tag scopes the read to that tag + globally-null rows, so
 *  an empty/invalid team ('') sees ONLY global facts — never a cross-team wildcard.
 *  An ABSENT (undefined/null) tag stays unscoped (the legacy unbound-bin behavior).
 *  Using a truthy check here was the scope-escape bug: '' is falsy, so it skipped
 *  the team filter and returned every team's facts. */
function provided(v: string | null | undefined): v is string {
  return v !== undefined && v !== null
}

/** Tokenise a free-text query into an FTS5 OR-of-quoted-terms (syntax-safe). */
function ftsMatchExpr(query: string): string | null {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' OR ')
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Scrub secrets out of free text BEFORE it is persisted. The shared memory
 *  store is the single write choke point (MCP + REST + every future writer), so
 *  a credential can never land in a durable, searchable, injectable fact. */
const scrubText = (s: string): string => String(scrubSecrets(s))

function rowToFact(row: DbMemoryFact): Fact {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    scopeAgentId: row.scopeAgentId,
    scopeTeamId: row.scopeTeamId,
    tenantId: row.tenantId,
    createdByAgentId: row.createdByAgentId,
    createdByRuntime: row.createdByRuntime,
    sourceTaskId: row.sourceTaskId,
    sourceSessionKey: row.sourceSessionKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowToProcedure(row: DbMemoryProcedure): Procedure {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    content: row.content,
    scopeAgentId: row.scopeAgentId,
    scopeTeamId: row.scopeTeamId,
    tenantId: row.tenantId,
    createdByAgentId: row.createdByAgentId,
    createdByRuntime: row.createdByRuntime,
    sourceTaskId: row.sourceTaskId,
    sourceSessionKey: row.sourceSessionKey,
    createdAt: row.createdAt,
  }
}

function rowToOutcome(row: DbMemoryOutcome): MemoryOutcome {
  return {
    id: row.id,
    factId: row.factId,
    outcome: row.outcome as MemoryOutcome['outcome'],
    note: row.note,
    agentId: row.agentId,
    teamId: row.teamId,
    taskId: row.taskId,
    runtime: row.runtime,
    createdAt: row.createdAt,
  }
}

/** Fact ids are UUIDs — a prefix lookup only accepts hex/hyphen chars so a
 *  user-supplied prefix can never smuggle LIKE wildcards. */
const SAFE_ID_PREFIX = /^[0-9a-fA-F-]{8,}$/

export class SqliteMemoryStore implements MemoryStore {
  constructor(
    private readonly db: ClawbooDb,
    private readonly embed?: EmbeddingProvider | null,
  ) {}

  /** Inclusive visibility: a scoped query also sees globally-scoped (null) rows;
   *  a tenant query is strict. Returns drizzle conditions for the facts table. */
  private factScopeConds(scope?: MemoryScope) {
    const conds = []
    if (provided(scope?.teamId))
      conds.push(
        sql`(${memoryFacts.scopeTeamId} = ${scope.teamId} OR ${memoryFacts.scopeTeamId} IS NULL)`,
      )
    if (provided(scope?.agentId))
      conds.push(
        sql`(${memoryFacts.scopeAgentId} = ${scope.agentId} OR ${memoryFacts.scopeAgentId} IS NULL)`,
      )
    if (provided(scope?.tenantId)) conds.push(eq(memoryFacts.tenantId, scope.tenantId))
    return conds
  }

  private loadScopedFacts(scope?: MemoryScope, limit?: number): DbMemoryFact[] {
    const conds = this.factScopeConds(scope)
    let q = this.db
      .select()
      .from(memoryFacts)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(memoryFacts.updatedAt))
      .$dynamic()
    if (limit) q = q.limit(limit)
    return q.all() as DbMemoryFact[]
  }

  async saveFact(input: SaveFactInput): Promise<Fact> {
    const now = Date.now()
    const id = randomUUID()
    const scope = input.scope ?? {}
    // Scrub-on-write: secrets never reach a durable / searchable / injectable fact.
    const title = scrubText(input.title)
    const content = scrubText(input.content)

    let embedding: Buffer | null = null
    let embeddingModel: string | null = null
    if (this.embed) {
      try {
        const [vec] = await this.embed.embed([factEmbeddingText(title, content)])
        if (vec && vec.length > 0) {
          embedding = serializeEmbedding(vec)
          embeddingModel = this.embed.id
        }
      } catch {
        /* embedding best-effort — FTS still works without it */
      }
    }

    const prov = input.provenance ?? {}
    const row: DbMemoryFactInsert = {
      id,
      title,
      content,
      tags: JSON.stringify(input.tags ?? []),
      embedding,
      embeddingModel,
      scopeAgentId: scope.agentId ?? null,
      scopeTeamId: scope.teamId ?? null,
      tenantId: scope.tenantId ?? null,
      createdByAgentId: prov.agentId ?? null,
      createdByRuntime: prov.runtime ?? null,
      sourceTaskId: prov.taskId ?? null,
      sourceSessionKey: prov.sessionKey ?? null,
      createdAt: now,
      updatedAt: now,
    }
    withWriteRetry(() => this.db.insert(memoryFacts).values(row).run())
    if (embeddingModel) markLocalFirstIfLocal(this.db, embeddingModel)

    return {
      id,
      title,
      content,
      tags: input.tags ?? [],
      scopeAgentId: scope.agentId ?? null,
      scopeTeamId: scope.teamId ?? null,
      tenantId: scope.tenantId ?? null,
      createdByAgentId: prov.agentId ?? null,
      createdByRuntime: prov.runtime ?? null,
      sourceTaskId: prov.taskId ?? null,
      sourceSessionKey: prov.sessionKey ?? null,
      createdAt: now,
      updatedAt: now,
    }
  }

  /** How many facts the backfill would index for `providerId`. Process-wide,
   *  not scoped: the backfill owns the whole store. */
  countFactsNeedingEmbedding(
    providerId: string,
    opts: { includeOtherModels?: boolean; excludeIds?: readonly string[] } = {},
  ): number {
    const excluded = opts.excludeIds ?? []
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(memoryFacts)
      .where(
        and(
          needsEmbedding(providerId, opts.includeOtherModels ?? true),
          excluded.length > 0 ? notInArray(memoryFacts.id, [...excluded]) : undefined,
        ),
      )
      .get()
    return row?.n ?? 0
  }

  /** Every fact in the store, of any scope. */
  countFacts(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(memoryFacts)
      .get()
    return row?.n ?? 0
  }

  /** Whether any fact carries a vector from a provider whose id starts with
   *  `prefix` (e.g. 'ollama:'): the store's record of which provider it uses.
   *  A range rather than LIKE, so the model index answers it with one seek. */
  hasFactsEmbeddedBy(prefix: string): boolean {
    const upper =
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
    const row = this.db
      .select({ id: memoryFacts.id })
      .from(memoryFacts)
      .where(
        and(
          sql`${memoryFacts.embeddingModel} >= ${prefix}`,
          sql`${memoryFacts.embeddingModel} < ${upper}`,
        ),
      )
      .limit(1)
      .get()
    return row != null
  }

  /**
   * Give facts a vector from the current provider, newest first, in bounded
   * batches.
   *
   * Save-time embedding is best-effort, so a fact saved while the provider was
   * down, missing its model, or not yet configured is stored with no vector.
   * A provider switch leaves every earlier vector in another model's space.
   * This pass indexes both.
   *
   * It never touches `updated_at`: that column drives the graph's recency fade,
   * and indexing a fact is not the fact changing. Pages walk a (created_at, id)
   * cursor written as a range the created_at index can seek, so a whole-store
   * pass reads each row about once. A batch the provider rejects as a request
   * (one input too large) is retried a fact at a time; a fact rejected on its
   * own is tried once more with a shorter prefix, then skipped rather than
   * blocking every older one. A provider-level failure (auth, quota, missing
   * model, outage) stops the pass. The write re-checks the need condition, so
   * a fact another writer embedded mid-pass is left alone.
   */
  async backfillEmbeddings(opts: BackfillEmbeddingsOpts = {}): Promise<BackfillEmbeddingsResult> {
    const embed = this.embed
    if (!embed) return { embedded: 0, skipped: [], remaining: 0, error: 'no embedding provider' }
    const batchSize = Math.max(1, Math.min(opts.batchSize ?? BACKFILL_BATCH, 256))
    const maxFacts = opts.maxFacts ?? Number.POSITIVE_INFINITY
    const includeOther = opts.reembedOtherModels ?? true
    // About to replace local vectors with a remote provider's: record that the
    // store was local first, while the vectors that say so still exist.
    if (includeOther && !embed.id.startsWith('ollama:')) storeIsLocalFirst(this.db)
    const need = needsEmbedding(embed.id, includeOther)
    const skipped: string[] = []
    const excluded = new Set(opts.skipIds ?? [])
    let embedded = 0
    let error: string | null = null
    let cursor: { createdAt: number; id: string } | null = null

    // Embed one fact on its own: a vector, a skip, or a provider-level failure.
    // `triedFull` skips re-sending the exact request that was just refused.
    const embedAlone = async (text: string, triedFull: boolean): Promise<number[] | 'skip'> => {
      const attempts = triedFull ? [] : [text]
      if (text.length > EMBED_TEXT_RETRY_CHARS) attempts.push(text.slice(0, EMBED_TEXT_RETRY_CHARS))
      for (const t of attempts) {
        try {
          const [v] = await embed.embed([t])
          return v && v.length > 0 ? v : 'skip'
        } catch (err) {
          if (!isRequestShapedEmbeddingError(err)) throw err
        }
      }
      return 'skip'
    }

    // Reads and writes can fail too (a damaged file, a full disk). The pass then
    // stops like it does on a provider error and still reports the vectors it
    // committed before the failure: a caller counting writes must see them.
    const failMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

    while (embedded < maxFacts && !opts.signal?.aborted) {
      let page: BackfillRow[]
      try {
        page = this.db
          .select({
            id: memoryFacts.id,
            title: memoryFacts.title,
            content: memoryFacts.content,
            createdAt: memoryFacts.createdAt,
          })
          .from(memoryFacts)
          .where(
            and(
              need,
              // "After the cursor" in (created_at DESC, id ASC) order, as a range
              // on created_at plus an exclusion: an OR here would force a scan.
              cursor
                ? sql`${memoryFacts.createdAt} <= ${cursor.createdAt} AND NOT (${memoryFacts.createdAt} = ${cursor.createdAt} AND ${memoryFacts.id} <= ${cursor.id})`
                : undefined,
            ),
          )
          .orderBy(desc(memoryFacts.createdAt), memoryFacts.id)
          .limit(Math.min(batchSize, maxFacts - embedded))
          .all()
      } catch (err) {
        error = failMessage(err)
        break
      }
      if (page.length === 0) break
      const last = page[page.length - 1]!
      cursor = { createdAt: last.createdAt, id: last.id }
      const rows = page.filter((r) => !excluded.has(r.id))
      if (rows.length === 0) continue

      const texts = rows.map((r) => factEmbeddingText(r.title, r.content))
      const vecs: (number[] | null)[] = []
      try {
        let batch: number[][]
        try {
          batch = await embed.embed(texts)
        } catch (err) {
          if (!isRequestShapedEmbeddingError(err)) throw err
          // One input sank the request: find it rather than give up on the page.
          batch = []
          for (const t of texts) {
            const v = await embedAlone(t, texts.length === 1)
            batch.push(v === 'skip' ? [] : v)
          }
        }
        if (batch.length !== rows.length) {
          error = `provider returned ${batch.length} vectors for ${rows.length} facts`
          break
        }
        batch.forEach((v, i) => {
          if (v && v.length > 0) vecs.push(v)
          else {
            vecs.push(null)
            skipped.push(rows[i]!.id)
          }
        })
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        break
      }
      if (opts.signal?.aborted) break

      let written: number
      try {
        written = immediateWrite(this.db, (tx) => {
          let n = 0
          rows.forEach((r, i) => {
            const v = vecs[i]
            if (!v) return
            const res = tx
              .update(memoryFacts)
              .set({ embedding: serializeEmbedding(v), embeddingModel: embed.id })
              .where(and(eq(memoryFacts.id, r.id), need))
              .run()
            n += res.changes
          })
          return n
        })
      } catch (err) {
        error = failMessage(err)
        break
      }
      embedded += written
      if (written > 0) markLocalFirstIfLocal(this.db, embed.id)
    }

    const excludeIds = [...excluded, ...skipped]
    let remaining = 0
    try {
      remaining = this.countFactsNeedingEmbedding(embed.id, {
        includeOtherModels: includeOther,
        excludeIds,
      })
    } catch (err) {
      error ??= failMessage(err)
    }
    return { embedded, skipped, remaining, error }
  }

  async searchMemory(query: string, opts: SearchOpts = {}): Promise<MemorySearchResult[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT
    const requested: SearchMode = opts.mode ?? (this.embed ? 'hybrid' : 'fts')
    // Vector/hybrid need an embedding provider; without one, fall back to FTS.
    const mode: SearchMode = requested !== 'fts' && !this.embed ? 'fts' : requested

    if (mode === 'fts') return this.searchFts(query, opts.scope, limit)

    let queryVec: number[] | null = null
    try {
      const [v] = await this.embed!.embed([query])
      queryVec = v && v.length > 0 ? v : null
    } catch {
      queryVec = null
    }
    if (!queryVec) return this.searchFts(query, opts.scope, limit) // embed failed → FTS

    if (mode === 'vector') return this.searchVector(query, queryVec, opts.scope, limit, false)
    return this.searchVector(query, queryVec, opts.scope, limit, true) // hybrid
  }

  private searchFts(
    query: string,
    scope: MemoryScope | undefined,
    limit: number,
  ): MemorySearchResult[] {
    const match = ftsMatchExpr(query)
    if (!match) return []
    const rows = this.db.all(
      sql`SELECT fact_id AS id, bm25(memory_facts_fts) AS rank FROM memory_facts_fts WHERE memory_facts_fts MATCH ${match} ORDER BY rank LIMIT ${FTS_CANDIDATE_CAP}`,
    ) as { id: string; rank: number }[]
    if (rows.length === 0) return []
    const orderedIds = rows.map((r) => r.id)
    const facts = this.factsByIds(orderedIds, scope)
    const out: MemorySearchResult[] = []
    orderedIds.forEach((id, i) => {
      const f = facts.get(id)
      if (f) out.push({ ...rowToFact(f), score: 1 - i / rows.length, matchedVia: 'fts' })
    })
    return out.slice(0, limit)
  }

  private searchVector(
    query: string,
    queryVec: number[],
    scope: MemoryScope | undefined,
    limit: number,
    hybrid: boolean,
  ): MemorySearchResult[] {
    const ftsHits = hybrid ? new Set(this.ftsCandidateIds(query, scope)) : new Set<string>()
    const candidates = this.loadScopedFacts(scope, FTS_CANDIDATE_CAP)
    const scored: MemorySearchResult[] = []
    for (const row of candidates) {
      const vec = deserializeEmbedding(row.embedding as Buffer | null)
      // Only compare vectors produced by the CURRENT embedding model — cross-model
      // cosine is meaningless even at a coincidentally-equal dimension, and would
      // silently corrupt ranking. A row from a different model is still findable via
      // FTS (in hybrid) / a future re-embed; here it just scores 0 on the vector axis.
      const sameModel = row.embeddingModel != null && row.embeddingModel === this.embed?.id
      const vScore =
        sameModel && vec && vec.length === queryVec.length
          ? (cosineSimilarity(queryVec, vec) + 1) / 2
          : 0
      const fScore = ftsHits.has(row.id) ? 1 : 0
      const score = hybrid ? 0.6 * vScore + 0.4 * fScore : vScore
      if (score > 0)
        scored.push({ ...rowToFact(row), score, matchedVia: hybrid ? 'hybrid' : 'vector' })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  private ftsCandidateIds(query: string, scope: MemoryScope | undefined): string[] {
    const match = ftsMatchExpr(query)
    if (!match) return []
    const rows = this.db.all(
      sql`SELECT fact_id AS id FROM memory_facts_fts WHERE memory_facts_fts MATCH ${match} LIMIT ${FTS_CANDIDATE_CAP}`,
    ) as { id: string }[]
    const ids = rows.map((r) => r.id)
    if (!scope) return ids
    // Re-filter the FTS ids by scope (FTS table isn't scope-aware).
    return [...this.factsByIds(ids, scope).keys()]
  }

  private factsByIds(ids: string[], scope?: MemoryScope): Map<string, DbMemoryFact> {
    if (ids.length === 0) return new Map()
    const conds = [inArray(memoryFacts.id, ids), ...this.factScopeConds(scope)]
    const rows = this.db
      .select()
      .from(memoryFacts)
      .where(and(...conds))
      .all() as DbMemoryFact[]
    return new Map(rows.map((r) => [r.id, r]))
  }

  browseMemory(opts: BrowseOpts = {}): Promise<Fact[]> {
    const rows = this.loadScopedFacts(opts.scope, opts.limit ?? DEFAULT_LIMIT)
    return Promise.resolve(rows.map(rowToFact))
  }

  saveProcedure(input: SaveProcedureInput): Promise<Procedure> {
    const now = Date.now()
    const scope = input.scope ?? {}
    const teamId = emptyToNull(scope.teamId)
    const agentId = emptyToNull(scope.agentId)
    const prior = this.db
      .select({ version: memoryProcedures.version })
      .from(memoryProcedures)
      .where(
        and(
          eq(memoryProcedures.name, input.name),
          eqOrNull(memoryProcedures.scopeTeamId, teamId),
          eqOrNull(memoryProcedures.scopeAgentId, agentId),
        ),
      )
      .orderBy(desc(memoryProcedures.version))
      .get() as { version: number } | undefined
    const version = (prior?.version ?? 0) + 1
    const prov = input.provenance ?? {}
    const row: Procedure = {
      id: randomUUID(),
      name: input.name,
      version,
      content: scrubText(input.content),
      scopeAgentId: agentId,
      scopeTeamId: teamId,
      tenantId: scope.tenantId ?? null,
      createdByAgentId: prov.agentId ?? null,
      createdByRuntime: prov.runtime ?? null,
      sourceTaskId: prov.taskId ?? null,
      sourceSessionKey: prov.sessionKey ?? null,
      createdAt: now,
    }
    withWriteRetry(() => this.db.insert(memoryProcedures).values(row).run())
    return Promise.resolve(row)
  }

  getProcedure(name: string, scope: MemoryScope = {}): Promise<Procedure | null> {
    const row = this.db
      .select()
      .from(memoryProcedures)
      .where(
        and(
          eq(memoryProcedures.name, name),
          eqOrNull(memoryProcedures.scopeTeamId, emptyToNull(scope.teamId)),
          eqOrNull(memoryProcedures.scopeAgentId, emptyToNull(scope.agentId)),
        ),
      )
      .orderBy(desc(memoryProcedures.version))
      .get() as DbMemoryProcedure | undefined
    return Promise.resolve(row ? rowToProcedure(row) : null)
  }

  listProcedures(opts: BrowseOpts = {}): Promise<Procedure[]> {
    const conds = []
    if (provided(opts.scope?.teamId))
      conds.push(
        sql`(${memoryProcedures.scopeTeamId} = ${opts.scope.teamId} OR ${memoryProcedures.scopeTeamId} IS NULL)`,
      )
    if (provided(opts.scope?.tenantId))
      conds.push(eq(memoryProcedures.tenantId, opts.scope.tenantId))
    const rows = this.db
      .select()
      .from(memoryProcedures)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(memoryProcedures.createdAt))
      .limit(opts.limit ?? DEFAULT_LIMIT)
      .all() as DbMemoryProcedure[]
    return Promise.resolve(rows.map(rowToProcedure))
  }

  /** Exact-id lookup, falling back to a unique 8+ char prefix. Scope-filtered:
   *  a fact invisible to the caller's scope resolves to null, so feedback can't
   *  be used as a cross-team existence oracle. */
  getFact(idOrPrefix: string, scope?: MemoryScope): Promise<Fact | null> {
    const exact = this.db
      .select()
      .from(memoryFacts)
      .where(and(eq(memoryFacts.id, idOrPrefix), ...this.factScopeConds(scope)))
      .get() as DbMemoryFact | undefined
    if (exact) return Promise.resolve(rowToFact(exact))
    if (!SAFE_ID_PREFIX.test(idOrPrefix)) return Promise.resolve(null)
    const rows = this.db
      .select()
      .from(memoryFacts)
      .where(and(sql`${memoryFacts.id} LIKE ${idOrPrefix + '%'}`, ...this.factScopeConds(scope)))
      .limit(2)
      .all() as DbMemoryFact[]
    return Promise.resolve(rows.length === 1 ? rowToFact(rows[0]!) : null)
  }

  /** Record an explicit outcome (or internal citation) against a fact. The fact
   *  must exist by exact id — callers resolve prefixes via getFact first. */
  recordOutcome(input: RecordOutcomeInput): Promise<MemoryOutcome> {
    const exists = this.db
      .select({ id: memoryFacts.id })
      .from(memoryFacts)
      .where(eq(memoryFacts.id, input.factId))
      .get()
    if (!exists) return Promise.reject(new Error(`unknown fact: ${input.factId}`))
    if (input.outcome === 'corrected' && !input.note?.trim())
      return Promise.reject(new Error('corrected requires a note'))
    const row: MemoryOutcome = {
      id: randomUUID(),
      factId: input.factId,
      outcome: input.outcome,
      // A correction could paste a secret — same scrub-on-write discipline.
      note: input.note != null ? scrubText(input.note) : null,
      agentId: input.agentId ?? null,
      teamId: input.teamId ?? null,
      taskId: input.taskId ?? null,
      runtime: input.runtime ?? null,
      createdAt: Date.now(),
    }
    withWriteRetry(() => this.db.insert(memoryOutcomes).values(row).run())
    return Promise.resolve(row)
  }

  /** The injection write path: one 'cited' row per fact used in a run's prompt.
   *  Deduped on (factId, taskId) so task retries/rotations never inflate usage. */
  recordCitations(
    factIds: string[],
    meta: {
      agentId?: string | null
      teamId?: string | null
      taskId?: string | null
      runtime?: string | null
    },
  ): Promise<void> {
    if (factIds.length === 0) return Promise.resolve()
    let toInsert = [...new Set(factIds)]
    if (meta.taskId != null) {
      const existing = this.db
        .select({ factId: memoryOutcomes.factId })
        .from(memoryOutcomes)
        .where(
          and(
            eq(memoryOutcomes.outcome, 'cited'),
            eq(memoryOutcomes.taskId, meta.taskId),
            inArray(memoryOutcomes.factId, toInsert),
          ),
        )
        .all() as { factId: string }[]
      const seen = new Set(existing.map((r) => r.factId))
      toInsert = toInsert.filter((id) => !seen.has(id))
    }
    if (toInsert.length === 0) return Promise.resolve()
    const now = Date.now()
    const rows: MemoryOutcome[] = toInsert.map((factId) => ({
      id: randomUUID(),
      factId,
      outcome: 'cited',
      note: null,
      agentId: meta.agentId ?? null,
      teamId: meta.teamId ?? null,
      taskId: meta.taskId ?? null,
      runtime: meta.runtime ?? null,
      createdAt: now,
    }))
    withWriteRetry(() => this.db.insert(memoryOutcomes).values(rows).run())
    return Promise.resolve()
  }

  listOutcomes(opts: { factIds?: string[]; limit?: number } = {}): Promise<MemoryOutcome[]> {
    if (opts.factIds && opts.factIds.length === 0) return Promise.resolve([])
    const limit = Math.min(opts.limit ?? 200, 1000)
    const rows = this.db
      .select()
      .from(memoryOutcomes)
      .where(opts.factIds ? inArray(memoryOutcomes.factId, opts.factIds) : undefined)
      .orderBy(desc(memoryOutcomes.createdAt), desc(memoryOutcomes.id))
      .limit(limit)
      .all() as DbMemoryOutcome[]
    return Promise.resolve(rows.map(rowToOutcome))
  }

  /** The one decoration call every read surface shares, so learning statuses
   *  are identical across REST browse/search/graph, MCP, and injection.
   *
   *  Windows outcomes PER FACT (not a single global cap): a fact's explicit
   *  feedback (useful/dead_end/corrected) is always retained — the partition
   *  orders explicit rows ahead of the high-volume 'cited' events, so a busy
   *  neighbour fact's citations can never evict this fact's negatives (which
   *  would break learning.ts's "negativeCount never decays away" invariant).
   *  'cited' rows fill the remainder newest-first, bounding cost per fact. */
  async learningForFacts(factIds: string[], now: number): Promise<Record<string, LearningEntry>> {
    if (factIds.length === 0) return {}
    const idList = sql.join(
      factIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = this.db.all(
      sql`SELECT id, fact_id, outcome, note, agent_id, team_id, task_id, runtime, created_at FROM (
            SELECT *, ROW_NUMBER() OVER (
              PARTITION BY fact_id
              ORDER BY (outcome = 'cited') ASC, created_at DESC, id DESC
            ) AS rn
            FROM memory_outcomes
            WHERE fact_id IN (${idList})
          ) WHERE rn <= ${LEARNING_OUTCOMES_PER_FACT_CAP}`,
    ) as {
      id: string
      fact_id: string
      outcome: string
      note: string | null
      agent_id: string | null
      team_id: string | null
      task_id: string | null
      runtime: string | null
      created_at: number
    }[]
    const outcomes: MemoryOutcome[] = rows.map((r) => ({
      id: r.id,
      factId: r.fact_id,
      outcome: r.outcome as MemoryOutcome['outcome'],
      note: r.note,
      agentId: r.agent_id,
      teamId: r.team_id,
      taskId: r.task_id,
      runtime: r.runtime,
      createdAt: r.created_at,
    }))
    return Object.fromEntries(computeLearningOverlay(outcomes, now))
  }

  /** Scoped facts with deserialized vectors — the graph projection's raw
   *  material. Embeddings stay in-process; they are never exposed over REST. */
  browseFactsWithVectors(opts: BrowseOpts = {}): Promise<FactVectorRow[]> {
    const rows = this.loadScopedFacts(opts.scope, opts.limit ?? FTS_CANDIDATE_CAP)
    return Promise.resolve(
      rows.map((row) => ({
        ...rowToFact(row),
        vector: deserializeEmbedding(row.embedding as Buffer | null),
        embeddingModel: row.embeddingModel,
      })),
    )
  }

  /** The full memory-graph payload for GET /api/memory/graph: newest-first
   *  capped rows → pure projection, decorated with the learning overlay. */
  async getMemoryGraph(
    opts: { scope?: MemoryScope; factLimit?: number; procedureLimit?: number } & Pick<
      ProjectMemoryGraphOpts,
      'simThreshold' | 'simTopK' | 'tagTopK' | 'providerId'
    > = {},
  ): Promise<MemoryGraphPayload> {
    const factLimit = Math.min(opts.factLimit ?? MAX_GRAPH_FACTS, MAX_GRAPH_FACTS)
    const procedureLimit = Math.min(
      opts.procedureLimit ?? MAX_GRAPH_PROCEDURES,
      MAX_GRAPH_PROCEDURES,
    )

    const factConds = this.factScopeConds(opts.scope)
    const totalFacts =
      (this.db
        .select({ c: sql<number>`count(*)` })
        .from(memoryFacts)
        .where(factConds.length ? and(...factConds) : undefined)
        .get()?.c as number | undefined) ?? 0

    const facts = await this.browseFactsWithVectors({ scope: opts.scope, limit: factLimit })

    // Procedures: team-inclusive + tenant-strict scope (mirrors listProcedures);
    // totalProcedures counts DISTINCT (name, scope) — the collapsed-node count —
    // in SQL, so the count never materializes every version row on the request path.
    const procConds = []
    if (provided(opts.scope?.teamId))
      procConds.push(
        sql`(${memoryProcedures.scopeTeamId} = ${opts.scope.teamId} OR ${memoryProcedures.scopeTeamId} IS NULL)`,
      )
    if (provided(opts.scope?.tenantId))
      procConds.push(eq(memoryProcedures.tenantId, opts.scope.tenantId))
    const procWhere = procConds.length ? sql` WHERE ${sql.join(procConds, sql` AND `)}` : sql``
    const totalProcedures =
      (
        this.db.get(
          sql`SELECT count(DISTINCT name || ' ' || COALESCE(scope_team_id, '') || ' ' || COALESCE(scope_agent_id, '')) AS c FROM memory_procedures${procWhere}`,
        ) as { c: number } | undefined
      )?.c ?? 0

    const procedures = await this.listProcedures({ scope: opts.scope, limit: procedureLimit })

    const learningRecord = await this.learningForFacts(
      facts.map((f) => f.id),
      Date.now(),
    )

    return projectMemoryGraph(
      facts,
      procedures,
      { totalFacts, totalProcedures },
      {
        simThreshold: opts.simThreshold,
        simTopK: opts.simTopK,
        tagTopK: opts.tagTopK,
        providerId: opts.providerId,
        learning: new Map(Object.entries(learningRecord)),
      },
    )
  }
}

/** Record that the store has local vectors, once. A no-op for a remote
 *  provider, and never allowed to fail the write that prompted it. */
function markLocalFirstIfLocal(db: ClawbooDb, providerId: string): void {
  if (!providerId.startsWith('ollama:')) return
  try {
    if (getSetting(db, LOCAL_FIRST_SETTING) !== '1') setSetting(db, LOCAL_FIRST_SETTING, '1')
  } catch {
    /* hasFactsEmbeddedBy still answers from the vectors themselves */
  }
}

/**
 * Whether resolving a provider for this store may pick a remote one. Once any
 * fact has had a local vector the store is local-first: a cloud provider is
 * used only while the user's explicit choice for the current Ollama outage
 * stands. Every process that embeds for the store (the dashboard server and
 * the stdio Memory bin) applies this, so a key in some process's environment
 * cannot move a locally indexed store to the cloud.
 */
export function storeAllowsRemoteEmbedding(db: ClawbooDb): boolean {
  if (!storeIsLocalFirst(db)) return true
  return getSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING) === '1'
}

/**
 * Whether the store has ever had a local vector. A store indexed before the
 * flag existed is recognised by its vectors, and the flag is written then, so
 * a later switch that replaces every local vector cannot erase the fact.
 */
export function storeIsLocalFirst(db: ClawbooDb): boolean {
  if (getSetting(db, LOCAL_FIRST_SETTING) === '1') return true
  if (!new SqliteMemoryStore(db).hasFactsEmbeddedBy('ollama:')) return false
  try {
    setSetting(db, LOCAL_FIRST_SETTING, '1')
  } catch {
    /* the vectors still answer until the write succeeds */
  }
  return true
}

/**
 * Called by any process after it resolves a provider. A local one serving
 * means the outage a choice of OpenAI answered is over, so the choice lapses
 * and the next outage asks again. Returns whether a choice was withdrawn.
 */
export function noteEmbeddingProviderServing(db: ClawbooDb, providerId: string): boolean {
  if (!providerId.startsWith('ollama:')) return false
  if (getSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING) !== '1') return false
  setSetting(db, REMOTE_EMBEDDING_CONSENT_SETTING, '0')
  return true
}
