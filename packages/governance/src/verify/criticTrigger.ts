// When to spend a read-only critic pass. The deterministic gate runs always; the
// critic is reserved for risky/large diffs so we don't pay a model on every tiny
// change — but it MUST fire on the high-risk surface (delegated work, big diffs)
// so a large change can't sneak through just because nobody asked for review.

export interface DiffStat {
  filesChanged: number
  insertions: number
  deletions: number
}

export interface CriticTriggerInput {
  diffStat: DiffStat
  /** Task has a parent ⇒ delegated work (delegation depth > 0 is inherently risky). */
  hasParent: boolean
  /** Explicit force (e.g. a task flagged sensitive). */
  riskFlag?: boolean
  threshold?: { files?: number; lines?: number }
}

export const DEFAULT_CRITIC_THRESHOLD = { files: 5, lines: 300 } as const

export function shouldRunCritic(input: CriticTriggerInput): boolean {
  if (input.riskFlag) return true
  if (input.hasParent) return true
  const files = input.threshold?.files ?? DEFAULT_CRITIC_THRESHOLD.files
  const lines = input.threshold?.lines ?? DEFAULT_CRITIC_THRESHOLD.lines
  if (input.diffStat.filesChanged > files) return true
  if (input.diffStat.insertions + input.diffStat.deletions > lines) return true
  return false
}
