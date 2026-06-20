// ─── Memory auto-injection ──────────────────────────────────────────────────
// At run start, seed the most-relevant facts for the task into the prompt's
// cache-safe VOLATILE tier — so a runtime begins with the team's accumulated
// knowledge without having to explicitly call the Memory MCP tool (it still can,
// for more). Reuses the exact SqliteMemoryStore + EmbeddingProvider stack the
// /api/memory REST surface uses (one source of truth), degrades to FTS with no
// provider, and is a NO-OP when memory is empty (fresh installs) — so this never
// changes behavior until the team has actually recorded facts.
//
// Bounded by a char budget (a few hundred tokens) so the seed never crowds out
// the real instruction, and best-effort: any failure returns '' rather than
// failing the run. Lands in `volatile` ONLY (never the cached prefix).

import {
  SqliteMemoryStore,
  resolveEmbeddingProvider,
  scanForInjection,
  scrubSecrets,
  type ClawbooDb,
  type EmbeddingProvider,
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
}

const OPEN = '<auto-memory note="bounded; top-K by relevance; not in the cache prefix">'
const CLOSE = '</auto-memory>'

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
    const results = await store.searchMemory(query, {
      mode: 'hybrid',
      limit: topK,
      scope: scopedRead,
    })
    if (results.length === 0) return ''

    // Reserve room for the wrapper so the TOTAL block stays within maxChars.
    const overhead = OPEN.length + CLOSE.length + 2 // two newlines around the body
    const bodyBudget = maxChars - overhead
    if (bodyBudget <= 0) return ''

    const lines: string[] = []
    let used = 0
    for (const r of results) {
      // Recall-sanitize: a poisoned "fact" must not smuggle instructions into a
      // teammate's run — drop any candidate that trips the injection scanner.
      if (scanForInjection(`${r.title}\n${r.content}`).length > 0) continue
      // Defense-in-depth scrub: facts are scrubbed on write, but a pre-existing
      // or externally-written fact must never re-surface a secret into context.
      const line = `- ${oneLine(scrubText(r.title))}: ${oneLine(scrubText(r.content))}`
      const cost = (lines.length > 0 ? 1 : 0) + line.length // + newline between lines
      if (used + cost > bodyBudget) break
      lines.push(line)
      used += cost
    }
    if (lines.length === 0) return ''

    return `${OPEN}\n${lines.join('\n')}\n${CLOSE}`
  } catch {
    // Best-effort: never fail a run because memory injection hiccuped.
    return ''
  }
}

/** Collapse whitespace/newlines so each fact renders as a single clean bullet. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Redact secret-looking values from a fact field before it enters the prompt. */
function scrubText(s: string): string {
  return String(scrubSecrets(s))
}
