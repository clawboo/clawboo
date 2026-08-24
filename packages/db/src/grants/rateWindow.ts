// The trailing-hour call counter behind `Grant.callCeilingPerHour`.
//
// IN-MEMORY, PER-PROCESS, AND THAT IS A DELIBERATE TRADE. The durable
// alternative is COUNT(*) over `tool_call_audit`, which is append-only and has
// no retention policy anywhere in the repo, executed synchronously on the
// request path. The honest framing is on the field itself: this is a runaway
// brake, not a quota, and nothing may treat it as a billing control.
//
// KNOWN LIMIT, stated so nobody discovers it as a surprise: `clawboo-mcp-tools`
// runs the same broker in a SEPARATE OS process with its own counter, so a
// determined local caller resets the window by spawning it. Closing that needs
// the durable count plus a memoised cache, which is its own slice.

const WINDOW_MS = 60 * 60_000

/** grantId -> ascending epoch-ms timestamps inside the trailing window. */
const calls = new Map<string, number[]>()

function prune(list: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS
  // Timestamps are appended in order, so the survivors are always a suffix.
  let i = 0
  while (i < list.length && list[i]! <= cutoff) i += 1
  return i === 0 ? list : list.slice(i)
}

/** Calls charged to this grant inside the trailing hour. */
export function callsInWindow(grantId: string, now = Date.now()): number {
  const list = calls.get(grantId)
  if (!list) return 0
  const kept = prune(list, now)
  if (kept.length === 0) calls.delete(grantId)
  else calls.set(grantId, kept)
  return kept.length
}

/**
 * Charge one call.
 *
 * Must be invoked in the SAME synchronous block as the `callsInWindow` read that
 * fed the decision. `decideGrant` is pure and synchronous precisely so that is
 * possible: read, decide and charge with no await between them, and concurrent
 * callers cannot all observe zero.
 */
export function chargeCall(grantId: string, now = Date.now()): void {
  const list = prune(calls.get(grantId) ?? [], now)
  list.push(now)
  calls.set(grantId, list)
}

/** Give a charge back when the call it was taken for never ran. */
export function releaseCall(grantId: string, now = Date.now()): void {
  const list = calls.get(grantId)
  if (!list || list.length === 0) return
  const kept = prune(list, now)
  kept.pop()
  if (kept.length === 0) calls.delete(grantId)
  else calls.set(grantId, kept)
}

/** Test seam. Never called in production. */
export function resetRateWindows(): void {
  calls.clear()
}
