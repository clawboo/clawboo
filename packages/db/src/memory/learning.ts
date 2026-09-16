// ─── Learning overlay — outcome-scored memory ───────────────────────────────
// A DERIVED experiential layer computed from memory_outcomes rows. It NEVER
// mutates durable facts — read surfaces merge it in at display/injection time.
// Pure + deterministic: no db import, no Date.now/Math.random; given the same
// (outcomes, now, opts) the output is byte-stable (fixed summation order).
//
// Future seam (staleness): when facts gain an optional structured sourceRef
// (path@repo) at save time, add a content fingerprint verified lazily where the
// referenced repo is resolvable and surface it as `stale: boolean` here — the
// UI already reserves the gray-dashed ring treatment for it.

import type { MemoryOutcome, OutcomeKind } from './types'

export type LearningStatus = 'preferred' | 'tentative' | 'contested' | 'dead_end'

export interface LearningTrailItem {
  kind: OutcomeKind
  createdAt: number
  agentId: string | null
  taskId: string | null
  runtime: string | null
  note: string | null
}

export interface LearningEntry {
  /** null = no scored signals (cited-only, or nothing but uses>0 metadata). */
  status: LearningStatus | null
  /** Present ONLY when status === 'contested' — the recency-decides verdict. */
  verdict?: 'useful' | 'avoid'
  /** Time-decayed signed sum (useful +w, dead_end/corrected −w, cited 0), 6dp. */
  score: number
  /** ALL signals including 'cited' — honest usage frequency, not endorsement. */
  uses: number
  /** DISTINCT (agentId, taskId) reporters of 'useful' — the corroboration count. */
  usefulCount: number
  /** Raw dead_end + corrected row count (never decays away; only weight does). */
  negativeCount: number
  lastUsedAt: number | null
  /** Newest-first, max trailSize. */
  recentTrail: LearningTrailItem[]
}

export const LEARNING_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface LearningOpts {
  halfLifeMs?: number
  trailSize?: number
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6

/**
 * Fold outcome rows into a per-fact learning entry.
 *
 * Status rules (evaluated in order):
 *   mixed signals            → 'contested' (verdict by score sign; tie → 'avoid')
 *   negatives only           → 'dead_end'
 *   ≥2 distinct corroborators → 'preferred'
 *   1 corroborator           → 'tentative'
 *   cited-only               → status null (uses/lastUsedAt still populated)
 *
 * Corroboration = distinct `(agentId, taskId)` pairs over 'useful' rows, so a
 * UI user double-clicking "helpful" collapses to ONE corroborator and can never
 * mint 'preferred' alone; two agents (or one agent across two tasks) can.
 */
export function computeLearningOverlay(
  outcomes: MemoryOutcome[],
  now: number,
  opts: LearningOpts = {},
): Map<string, LearningEntry> {
  const halfLifeMs = opts.halfLifeMs ?? LEARNING_HALF_LIFE_MS
  const trailSize = opts.trailSize ?? 5

  const byFact = new Map<string, MemoryOutcome[]>()
  for (const o of outcomes) {
    const list = byFact.get(o.factId)
    if (list) list.push(o)
    else byFact.set(o.factId, [o])
  }

  const entries: [string, LearningEntry][] = []
  for (const [factId, rows] of byFact) {
    // Fixed FP addition order (createdAt asc, id asc) ⇒ byte-stable score
    // regardless of input order.
    const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))

    let score = 0
    const corroborators = new Set<string>()
    let negativeCount = 0
    let lastUsedAt: number | null = null
    for (const o of sorted) {
      // Future timestamps clamp to weight 1 — a bad clock never amplifies.
      const w = 0.5 ** (Math.max(0, now - o.createdAt) / halfLifeMs)
      if (o.outcome === 'useful') {
        score += w
        corroborators.add(`${o.agentId ?? ''}::${o.taskId ?? ''}`)
      } else if (o.outcome === 'dead_end' || o.outcome === 'corrected') {
        score -= w
        negativeCount += 1
      }
      // 'cited' contributes 0 to score — usage is data, not endorsement.
      if (lastUsedAt === null || o.createdAt > lastUsedAt) lastUsedAt = o.createdAt
    }

    const usefulCount = corroborators.size
    let status: LearningStatus | null
    let verdict: 'useful' | 'avoid' | undefined
    if (usefulCount > 0 && negativeCount > 0) {
      status = 'contested'
      verdict = score > 0 ? 'useful' : 'avoid' // tie (score===0) → 'avoid', conservative
    } else if (negativeCount > 0) {
      status = 'dead_end'
    } else if (usefulCount >= 2) {
      status = 'preferred'
    } else if (usefulCount === 1) {
      status = 'tentative'
    } else {
      status = null // cited-only
    }

    const recentTrail: LearningTrailItem[] = [...sorted]
      .sort((a, b) => b.createdAt - a.createdAt || (a.id > b.id ? -1 : 1))
      .slice(0, trailSize)
      .map((o) => ({
        kind: o.outcome,
        createdAt: o.createdAt,
        agentId: o.agentId,
        taskId: o.taskId,
        runtime: o.runtime,
        note: o.note,
      }))

    const entry: LearningEntry = {
      status,
      score: round6(score),
      uses: rows.length,
      usefulCount,
      negativeCount,
      lastUsedAt,
      recentTrail,
    }
    if (verdict !== undefined) entry.verdict = verdict
    entries.push([factId, entry])
  }

  // Deterministic map iteration order (factId asc) for stable serialization.
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return new Map(entries)
}
