// Risky-delegation heuristic for the server team-orchestration engine's approval
// gate. This is the exact keyword pattern the (retired) browser orchestration path
// used, restored server-side for parity: a delegation whose task text mentions a
// destructive / irreversible / secret-touching action is surfaced on the leader's
// approval queue before it runs (the engine's `isRiskyDelegation` + the DB-mediated
// `requestDelegationApproval` handshake). Routine work never trips it.
//
// The keyword match is intentionally broad (parity with the browser). Because the
// engine awaits each delegation's approval serially within a fan-out turn, a false
// positive costs latency (the leader must approve, or the approval times out); it is
// never destructive (fail-closed → skip). Tightening the pattern is an owner decision.

export const RISKY_DELEGATION_RE =
  /\b(delete|destroy|drop\s+table|deploy|publish|release|rm\s+-rf|prod(uction)?|secret|credential|api[_-]?key|force[_-]?push)\b/i

/** True when the delegated task text reads as a risky action needing leader approval. */
export function isRiskyDelegation(signal: { task: string }): boolean {
  return RISKY_DELEGATION_RE.test(signal.task)
}
