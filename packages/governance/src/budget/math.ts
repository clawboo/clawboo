// Budget math in integer CENTS — exact, so the atomic SQL increment and this pure
// predicate agree byte-for-byte. The DB `recordSpend` is the authority (one
// `UPDATE … RETURNING`); this mirror exists for unit-testing the tier boundaries
// and for any client-side projection. Soft tier at 80%, hard auto-pause at 100%.

export type BudgetStatus = 'active' | 'soft_capped' | 'paused'
export type BudgetCrossing = 'none' | 'soft' | 'hard'

export const SOFT_CAP_PERCENT = 80

/** Convert a (possibly fractional / non-finite) USD amount to non-negative cents,
 *  ROUNDED. Use for display + the integer-cent per-node cap. NOT for the budget
 *  ledger: a sub-half-cent amount rounds to 0 here, so repeated tiny events would
 *  vanish — the ledger uses {@link usdToFractionalCents} + a micro-cent carry. */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return Math.round(usd * 100)
}

/** Convert USD to FRACTIONAL cents (NOT rounded) for the budget ledger. Repeated
 *  sub-cent events (e.g. $0.004 ⇒ 0.4¢) must accumulate losslessly, so the
 *  rounding happens once, downstream, against a micro-cent carry in `recordSpend`
 *  — never per event here (which would floor each to 0). */
export function usdToFractionalCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0
  return usd * 100
}

/** Micro-cents (ten-thousandths of a cent) per whole cent. The budget ledger
 *  accumulates spend in micro-cents so sub-cent deltas carry across events; the
 *  displayed `spentUsdCents` is `floor(microCents / MICRO_CENTS_PER_CENT)`. */
export const MICRO_CENTS_PER_CENT = 10_000

export function centsToUsd(cents: number): number {
  return cents / 100
}

/** The soft-cap threshold in cents, using the SAME integer arithmetic as the SQL
 *  CASE (`limit * 80 / 100` with integer division) so the two never disagree. */
export function softThresholdCents(limitCents: number): number {
  return Math.floor((limitCents * SOFT_CAP_PERCENT) / 100)
}

export function statusForSpend(limitCents: number, spentCents: number): BudgetStatus {
  if (limitCents <= 0) return 'active' // no/zero limit ⇒ uncapped semantics
  if (spentCents >= limitCents) return 'paused'
  if (spentCents >= softThresholdCents(limitCents)) return 'soft_capped'
  return 'active'
}

export interface BudgetStatusInput {
  limitCents: number
  /** Spend BEFORE this delta. */
  spentCents: number
  deltaCents: number
}

export interface BudgetStatusResult {
  status: BudgetStatus
  crossed: BudgetCrossing
  newSpentCents: number
}

/**
 * Apply a spend delta and report the resulting status plus which threshold (if
 * any) this delta CROSSED — `crossed` is non-`none` only on the event that tips
 * over, so the caller can act exactly once (audit, abort) per crossing.
 */
export function budgetStatusAfter({
  limitCents,
  spentCents,
  deltaCents,
}: BudgetStatusInput): BudgetStatusResult {
  const newSpentCents = spentCents + deltaCents
  const before = statusForSpend(limitCents, spentCents)
  const after = statusForSpend(limitCents, newSpentCents)
  let crossed: BudgetCrossing = 'none'
  if (after === 'paused' && before !== 'paused') crossed = 'hard'
  else if (after === 'soft_capped' && before === 'active') crossed = 'soft'
  return { status: after, crossed, newSpentCents }
}
