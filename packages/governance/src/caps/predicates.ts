// Orchestrator-boundary caps, enforced IN CODE below the model — independent of
// what the model asks for. depth (how deep a delegation tree may go), fan-out
// (how many siblings one parent may spawn), and per-node cost (a single run's
// cent ceiling). Pure predicates; the call sites (server runner + client
// orchestrator) own where the counts come from.

export interface CapResult {
  ok: boolean
  reason?: string
}

export const DEFAULT_MAX_DEPTH = 2

/** Reject once the existing ancestor depth has reached the max (would create depth+1). */
export function checkDepthCap({ depth, max }: { depth: number; max: number }): CapResult {
  if (depth >= max) return { ok: false, reason: `delegation depth ${depth} >= max ${max}` }
  return { ok: true }
}

/** Reject once a parent already has `max` (or more) sibling children. */
export function checkFanoutCap({
  siblingCount,
  max,
}: {
  siblingCount: number
  max: number
}): CapResult {
  if (siblingCount >= max) return { ok: false, reason: `fan-out ${siblingCount} >= max ${max}` }
  return { ok: true }
}

/** Reject once a single run's accrued cost reaches the per-node ceiling (cents).
 *  `>=` so "at the cap = enforced" matches the budget hard cap (`spent >= limit`)
 *  — the two cent ceilings treat the exact-boundary case identically. */
export function checkCostCap({ nodeCents, max }: { nodeCents: number; max: number }): CapResult {
  if (nodeCents >= max) return { ok: false, reason: `node cost ${nodeCents}¢ >= max ${max}¢` }
  return { ok: true }
}
