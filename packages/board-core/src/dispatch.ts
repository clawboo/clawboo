// ─── Dispatch rules ─────────────────────────────────────────────────────────
// Whether a `todo` task will ever be picked up on its own, decided from two
// durable facts the board already stores:
//
//   · the agent a task is BOUND to, carried in its `sourceDelegationId` as an
//     `:agent:<id>` segment (every engine delegation writes one, and so does a
//     person assigning a task from the board);
//   · the task's execution LEDGER, which the ready-pump reads before it re-fires
//     released work (a user Stop is never undone, a task that keeps failing is
//     parked instead of fed forever).
//
// These used to be restated in @clawboo/team-orchestration (the engine's pump)
// and in @clawboo/db (the server's pump scan) with a test asserting the copies
// agreed. They live here now, below both, so there is one rule instead of two
// kept in step, and the board UI can explain a stuck card with the same logic
// that decided it was stuck.
//
// Import-free on purpose, like the state machine: this module ships into the
// Vite SPA.

/** One run in a task's execution ledger: its outcome, and the error it ended
 *  with when it failed (what the needs-you column shows as the reason). */
export interface LedgerRun {
  status: string
  error?: string | null
}

/**
 * Durable auto-refire cap: the ready-pump re-fires a released task until the
 * tail of its ledger holds this many consecutive runs that neither succeeded nor
 * were stopped by the user. The ledger IS the counter, so it survives restarts.
 */
export const MAX_AUTO_FIRES = 3

/**
 * How many runs at the END of the ledger ended without success and without a
 * user Stop (`failed`, `timed_out`, an orphan reaped as failed). A success or a
 * Stop in between resets the count, so a task that failed twice long ago is not
 * penalised forever.
 */
export function trailingFailedRuns(execs: readonly LedgerRun[]): number {
  let trailing = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const s = execs[i]!.status
    if (s === 'succeeded' || s === 'cancelled') break
    trailing += 1
  }
  return trailing
}

/**
 * The ready-pump's fire policy over a task's ledger (oldest run first):
 *   • empty ledger → never delivered (fresh, deferred, assigned) → fire;
 *   • last run `running` → someone owns it → leave it;
 *   • last run `cancelled` → the user STOPPED it → never auto-refire (a person
 *     re-queues it deliberately);
 *   • MAX_AUTO_FIRES consecutive unsuccessful runs at the tail → park it;
 *   • otherwise (timed out / failed / orphaned) → infrastructure death, not
 *     intent → re-fire.
 */
export function ledgerAllowsAutoFire(execs: readonly LedgerRun[]): boolean {
  if (execs.length === 0) return true
  const last = execs[execs.length - 1]!.status
  if (last === 'running' || last === 'cancelled') return false
  return trailingFailedRuns(execs) < MAX_AUTO_FIRES
}

/**
 * The agent a task is bound to, decoded from its `sourceDelegationId`, or null
 * when the task names none (a legacy manual card, an agent's own `create_task`).
 * Agent ids never contain a colon, which is what makes `[^:]+` exact.
 */
export function delegationTargetOf(sourceDelegationId: string | null | undefined): string | null {
  if (!sourceDelegationId) return null
  return sourceDelegationId.match(/:agent:([^:]+)/)?.[1] ?? null
}

const HUMAN_ORIGIN_RE = /(?:^|:)origin:human(?::|$)/

/**
 * Did a PERSON bind this task to its agent (the board's New task dialog, or an
 * explicit assignment), rather than an agent delegating it? A person-assigned
 * task reports back to the person, on its card: no agent is waiting on it, so
 * the engine must not hand its result to the team lead as a `[Task Update]`.
 */
export function isHumanAssignment(sourceDelegationId: string | null | undefined): boolean {
  return !!sourceDelegationId && HUMAN_ORIGIN_RE.test(sourceDelegationId)
}

/**
 * The `sourceDelegationId` for a task a person assigned to `agentId`. It carries
 * the `:agent:` segment the dispatcher fires on and deliberately NO `:reflectTo:`
 * segment, so nothing in the engine can resolve an agent to report the result
 * to. `nonce` keeps two identical assignments distinct in the ledger.
 */
export function encodeHumanAssignment(agentId: string, nonce: string): string {
  return `assign:${nonce}:agent:${agentId}:origin:human`
}
