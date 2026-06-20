// Tool-loop circuit breakers — the deterministic, cross-runtime BACKSTOP that
// halts a run going nowhere. It is a distinct safety net from the budget
// kill-switch (which stops on dollars) and a runtime's own max-turns (which stops
// on iteration count, per runtime): these breakers stop a run that burns
// turns/tokens making NO PROGRESS or repeating the same failing tool call, BEFORE
// the dollar ceiling is reached. Conservative defaults — a healthy run never
// trips; only a thrashing or runaway loop does. Pure config; the reducer in
// ./machine consumes it.

export interface BreakerConfig {
  /** Hard ceiling on settled tool-calls in a single run. */
  maxToolIterations: number
  /** Consecutive identical-tool failures (same tool + same input) before halting. */
  repeatFailureThreshold: number
  /** Consecutive tool-results that add no NEW successful output before halting. */
  noProgressThreshold: number
  /** Tokens-per-minute ceiling — only egregious runaways trip. Needs ≥2 cost
   *  events spanning `velocityMinWindowMs`: reachable on per-turn-cost runtimes
   *  (native) + across rotations; a one-cost-per-run wrapped adapter never trips
   *  it in a single run (a multi-rotation backstop there). */
  tokenVelocityCeiling: number
  /** Don't evaluate velocity until the measurement window spans at least this many
   *  ms, so an early burst can't false-trip a short-lived run. */
  velocityMinWindowMs: number
  /** Consecutive identical policy-denial codes before halting. */
  repeatPolicyDeniedThreshold: number
}

export const BREAKER_DEFAULTS: BreakerConfig = {
  maxToolIterations: 30,
  repeatFailureThreshold: 3,
  noProgressThreshold: 6,
  tokenVelocityCeiling: 200_000,
  velocityMinWindowMs: 15_000,
  repeatPolicyDeniedThreshold: 2,
}
