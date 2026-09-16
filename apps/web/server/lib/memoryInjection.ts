// ─── Memory auto-injection ──────────────────────────────────────────────────
// At run start, seed the most-relevant facts for the task into the prompt's
// cache-safe VOLATILE tier — so a runtime begins with the team's accumulated
// knowledge without having to explicitly call the Memory MCP tool (it still can,
// for more). Reuses the exact SqliteMemoryStore + EmbeddingProvider stack the
// /api/memory REST surface uses (one source of truth), degrades to FTS with no
// provider, and is a NO-OP when memory is empty (fresh installs) — so this never
// changes behavior until the team has actually recorded facts.
//
// The learning overlay re-ranks the seeds (dead_end facts are dropped entirely —
// still findable via explicit memory_search, where the status is visible), a
// hub-avoiding 1-hop graph expansion admits up to 2 related facts under the same
// budget, every rendered line carries an 8-char `(id …)` citation prefix, and a
// 'cited' outcome row is recorded per rendered fact (deduped on (factId, taskId)
// so rotations/retries never inflate usage counts).
//
// Bounded by a char budget (a few hundred tokens) so the seed never crowds out
// the real instruction, and best-effort: any failure returns '' rather than
// failing the run. Lands in `volatile` ONLY (never the cached prefix).

import {
  SqliteMemoryStore,
  computeFactEdges,
  evaluateInjection,
  neighborsOf,
  resolveEmbeddingProvider,
  scrubSecrets,
  type ClawbooDb,
  type EmbeddingProvider,
  type LearningEntry,
  type MemoryScope,
} from '@clawboo/db'

// Resolve the embedding provider once (a network probe) and reuse — mirrors the
// /api/memory caching. Null → FTS-only (hybrid search degrades gracefully).
let embedProviderPromise: Promise<EmbeddingProvider | null> | null = null
function getEmbedProvider(): Promise<EmbeddingProvider | null> {
  if (!embedProviderPromise) embedProviderPromise = resolveEmbeddingProvider().catch(() => null)
  return embedProviderPromise
}

/** Test-only: reset the cached provider promise between cases. */
export function __resetEmbedProviderCacheForTests(): void {
  embedProviderPromise = null
}

/** Test-only: pin the provider (bypasses the network probe) — lets the suite
 *  drive the similarity-edge expansion path with a deterministic provider. */
export function __setEmbedProviderForTests(provider: EmbeddingProvider | null): void {
  embedProviderPromise = Promise.resolve(provider)
}

export interface BuildMemoryInjectionInput {
  db: ClawbooDb
  /** The search query (typically the task title + description). */
  query: string
  /** Visibility scope (team + agent; global facts are always included). */
  scope: MemoryScope
  /** Hard char cap on the rendered block. `<= 0` disables injection (returns ''). */
  maxChars: number
  /** Max facts to seed. `<= 0` disables injection (returns ''). */
  topK: number
  /** Citation provenance — the 'cited' rows dedupe on (factId, taskId). */
  taskId?: string | null
  runtime?: string | null
}

const OPEN =
  '<auto-memory note="bounded; top-K by relevance + related; report with memory_feedback citing the id">'
const CLOSE = '</auto-memory>'

// Learning re-rank boosts — sized to reorder near-ties within the 0..1 score
// scale without letting a stale preferred beat a strong fresh match.
const PREFERRED_BOOST = 0.15
const TENTATIVE_BOOST = 0.05
const CONTESTED_SUFFIX = ' [contested — recent feedback conflicts; verify]'

// 1-hop expansion bounds: hub-avoiding, and budget-capped so a single hub fact
// cannot crowd the seeds out of the block.
const SEED_FETCH_CAP = 50
const EXPANSION_MAX = 2
const EXPANSION_SIM_THRESHOLD = 0.8
const EXPANSION_MAX_EDGES_PER_FACT = 6
const EXPANSION_DEGREE_CAP = 8
const EXPANSION_ROW_LIMIT = 200

/**
 * Build the `<auto-memory>` block, or '' when injection is disabled (non-positive
 * budget), the query is blank, or no facts match. The wrapper is only emitted
 * when at least one fact fits within `maxChars`.
 */
export async function buildMemoryInjection(input: BuildMemoryInjectionInput): Promise<string> {
  const { db, query, scope, maxChars, topK } = input
  if (maxChars <= 0 || topK <= 0) return ''
  if (!query.trim()) return ''

  try {
    const provider = await getEmbedProvider()
    const store = new SqliteMemoryStore(db, provider)
    // A team-less run (teamId null/absent) must see ONLY global facts — never every
    // team's shared facts. The store maps '' to global-only (via `provided`); a null
    // teamId would otherwise skip the team filter entirely (the cross-team leak). A
    // real team id passes through unchanged.
    const scopedRead: MemoryScope = { ...scope, teamId: scope.teamId ?? '' }
    // Over-fetch so the learning re-rank has slack to drop/reorder.
    const results = await store.searchMemory(query, {
      mode: 'hybrid',
      limit: Math.min(topK * 2, SEED_FETCH_CAP),
      scope: scopedRead,
    })
    if (results.length === 0) return ''

    const now = Date.now()
    const learning: Record<string, LearningEntry> = await store.learningForFacts(
      results.map((r) => r.id),
      now,
    )
    const statusOf = (id: string): LearningEntry['status'] => learning[id]?.status ?? null
    const boostOf = (id: string): number => {
      const s = statusOf(id)
      return s === 'preferred' ? PREFERRED_BOOST : s === 'tentative' ? TENTATIVE_BOOST : 0
    }
    // dead_end dropped entirely — a known-bad fact must not be re-seeded (it
    // stays findable via explicit memory_search, where its status is visible).
    const seeds = results
      .filter((r) => statusOf(r.id) !== 'dead_end')
      .map((r) => ({ r, adjusted: r.score + boostOf(r.id) }))
      .sort((a, b) => b.adjusted - a.adjusted)
      .slice(0, topK)
      .map(({ r }) => r)
    if (seeds.length === 0) return ''

    // Reserve room for the wrapper so the TOTAL block stays within maxChars.
    const overhead = OPEN.length + CLOSE.length + 2 // two newlines around the body
    const bodyBudget = maxChars - overhead
    if (bodyBudget <= 0) return ''

    // Every rendered line cites an 8-char id prefix (memory_feedback accepts it).
    const renderLine = (
      f: { id: string; title: string; content: string },
      related: boolean,
    ): string => {
      const contested = statusOf(f.id) === 'contested' ? CONTESTED_SUFFIX : ''
      const prefix = related ? 'related — ' : ''
      return `- (id ${f.id.slice(0, 8)}) ${prefix}${oneLine(scrubText(f.title))}: ${oneLine(scrubText(f.content))}${contested}`
    }

    const lines: string[] = []
    const renderedIds: string[] = []
    let used = 0
    for (const r of seeds) {
      // Recall-sanitize: a poisoned "fact" must not smuggle instructions into a
      // teammate's run — drop any candidate that trips the injection scanner.
      if (blockedByInjection(r.id, r.title, r.content)) continue
      // Defense-in-depth scrub (inside renderLine): facts are scrubbed on write,
      // but a pre-existing or externally-written fact must never re-surface a
      // secret into context.
      const line = renderLine(r, false)
      const cost = (lines.length > 0 ? 1 : 0) + line.length // + newline between lines
      if (used + cost > bodyBudget) break
      lines.push(line)
      renderedIds.push(r.id)
      used += cost
    }
    if (lines.length === 0) return ''

    // 1-hop hub-avoiding expansion: admit up to EXPANSION_MAX related facts
    // under the SAME budget. Degrades cleanly: no provider ⇒ tag edges only;
    // and it is best-effort — a hiccup here must not drop the seeds.
    try {
      const rows = await store.browseFactsWithVectors({
        scope: scopedRead,
        limit: EXPANSION_ROW_LIMIT,
      })
      const edges = computeFactEdges(rows, {
        providerId: provider?.id ?? null,
        simThreshold: EXPANSION_SIM_THRESHOLD,
        maxEdgesPerFact: EXPANSION_MAX_EDGES_PER_FACT,
      })
      const nbrs = neighborsOf(renderedIds, edges, { degreeCap: EXPANSION_DEGREE_CAP })
      const nbrLearning = await store.learningForFacts([...nbrs.keys()], now)
      const rowById = new Map(rows.map((r) => [r.id, r]))
      let admitted = 0
      for (const id of nbrs.keys()) {
        // Weight-desc iteration (neighborsOf's order); the same guards as seeds.
        if (admitted >= EXPANSION_MAX) break
        if ((nbrLearning[id]?.status ?? null) === 'dead_end') continue
        const fact = rowById.get(id)
        if (!fact) continue
        if (blockedByInjection(id, fact.title, fact.content)) continue
        const contested = (nbrLearning[id]?.status ?? null) === 'contested' ? CONTESTED_SUFFIX : ''
        const line = `- (id ${id.slice(0, 8)}) related — ${oneLine(scrubText(fact.title))}: ${oneLine(scrubText(fact.content))}${contested}`
        const cost = 1 + line.length // a seed line always precedes a neighbor
        if (used + cost > bodyBudget) break
        lines.push(line)
        renderedIds.push(id)
        used += cost
        admitted += 1
      }
    } catch {
      /* expansion is best-effort — the seed block still renders */
    }

    // Citation write: usage frequency as data (never endorsement). Inner
    // try/catch — a failed outcomes write must not kill the block.
    try {
      await store.recordCitations(renderedIds, {
        agentId: scope.agentId ?? null,
        teamId: scope.teamId ?? null,
        taskId: input.taskId ?? null,
        runtime: input.runtime ?? null,
      })
    } catch {
      /* best-effort */
    }

    return `${OPEN}\n${lines.join('\n')}\n${CLOSE}`
  } catch {
    // Best-effort: never fail a run because memory injection hiccuped.
    return ''
  }
}

/**
 * Recall-sanitize: a poisoned "fact" must not smuggle instructions into a
 * teammate's run. The text is bound for a prompt, but `strict` promotes
 * machine-directed findings to blocking too: dropping one recalled fact costs
 * nothing, so this stays the drop-on-any-finding gate it has always been.
 * Applied identically to seeds and to expansion neighbours.
 */
function blockedByInjection(id: string, title: string, content: string): boolean {
  return evaluateInjection(`${title}\n${content}`, {
    surface: 'prompt',
    strict: true,
    scope: `memory:${id}`,
  }).blocked
}

/** Collapse whitespace/newlines so each fact renders as a single clean bullet. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Redact secret-looking values from a fact field before it enters the prompt. */
function scrubText(s: string): string {
  return String(scrubSecrets(s))
}
