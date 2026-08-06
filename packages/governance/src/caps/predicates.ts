// Orchestrator-boundary caps, enforced IN CODE below the model — independent of
// what the model asks for. depth (how deep a delegation tree may go), fan-out
// (how many siblings one parent may spawn), and per-node cost (a single run's
// cent ceiling). Pure predicates; the call sites (server runner, team
// orchestrator, the board's capped create path) own where the counts come from.

export interface CapResult {
  ok: boolean
  reason?: string
}

export const DEFAULT_MAX_DEPTH = 2

/** Per-parent LIFETIME child ceiling for the board's capped create path: 3x the
 *  team-chat per-TURN fan-out, so several legitimate delegation rounds under one
 *  parent still fit while a looping agent trips almost immediately. Distinct from
 *  the per-turn fan-out (8): this bounds live rows under one parent across a whole
 *  mission, not how many siblings a single turn may spawn. */
export const DEFAULT_MAX_CHILDREN = 24

/** Rolling-window RATE ceiling for ROOT task creation, and its window. A
 *  per-parent cap has no subject on a root create, so this is the bound that
 *  stops the other runaway shape: an agent looping `create_task` with no parent.
 *  A rate rather than a lifetime total on purpose — a lifetime cap on roots would
 *  permanently jam a long-lived board, while velocity is the actual runaway
 *  signature and self-clears once the window rolls. 30 per 5 minutes sits far
 *  above any human or sane-agent filing rate and trips a loop in seconds. */
export const DEFAULT_MAX_ROOT_CREATES = 30
export const DEFAULT_ROOT_CREATE_WINDOW_MS = 5 * 60_000

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
