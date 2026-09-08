// Which tool calls the activity log has already recorded.
//
// TWO WRITERS, ONE LOG. `executorRunner` records the tool calls of runs clawboo
// STARTED, off the `chat` and `agent` streams that are addressed to the
// connection that started them. The session-activity watcher records everything
// else, off `session.message`, which fires on transcript commit regardless of who
// is watching — that is the only channel carrying work a Boo starts on its own.
//
// Those two sets OVERLAP. A run clawboo started also commits transcript rows, so
// without a shared ledger every tool call of every ordinary run would appear
// twice in the feed. A duplicate is not a cosmetic problem here: the feed is what
// an operator reads to understand what an agent did, and a doubled command reads
// as the agent having run it twice.
//
// BOUNDED ON PURPOSE, and it forgets the oldest entries rather than growing. The
// failure mode of forgetting is one duplicated row long after the fact; the
// failure mode of not forgetting is a set that grows for the life of the process.
// The first is a blemish, the second is a leak.

/** Roughly an hour of busy fleet activity, and a few hundred KB at worst. */
const MAX_REMEMBERED = 2_000

const seen = new Set<string>()

/**
 * Record a tool call as logged, and say whether it was new.
 *
 * Returns false when this id has already been recorded, which is the caller's
 * signal to skip it. Insertion order is the eviction order: `Set` preserves it,
 * so the oldest id is always the first key.
 */
export function markToolCallLogged(toolCallId: string): boolean {
  if (!toolCallId) return true // Unidentifiable calls cannot be deduped; let them through.
  if (seen.has(toolCallId)) return false
  seen.add(toolCallId)
  if (seen.size > MAX_REMEMBERED) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

/** Test seam. Never call from production code: forgetting mid-run duplicates rows. */
export function resetLoggedToolCalls(): void {
  seen.clear()
}
