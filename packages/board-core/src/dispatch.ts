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
  /** The class the failure was filed under, from the runtime error taxonomy
   *  (`classifyError` in @clawboo/obs). Null for a run that did not fail, and
   *  for one closed before the ledger recorded it. */
  errorClass?: string | null
  /** Who ran it: the runtime, or an owner such as the team engine. */
  executorType?: string | null
  /** The runtime that ran it, when `executorType` names an owner instead. */
  runtime?: string | null
  /** When the run started, was claimed and was recorded (epoch ms). */
  startedAt?: number | null
  claimedAt?: number | null
  createdAt?: number | null
  /** When the run ended (epoch ms). The no-progress brake counts its wait from it. */
  completedAt?: number | null
  /** Whether the run made visible progress (see `runMadeProgress`), as stored on
   *  the ledger row: 1 or 0. Null for a run with no verdict, and for one closed
   *  before the ledger recorded it, which reads from its outcome instead. */
  madeProgress?: boolean | number | null
}

/** What a person has to fix before the same work can run: the runtime's
 *  sign-in, or the provider account's billing. */
export type AccountFailure = 'sign_in' | 'billing'

/**
 * The account problem a run failed on, or null. These are the taxonomy's `Auth`
 * and `Billing` classes, spelled out because this module imports nothing (a test
 * in @clawboo/db holds the two spellings together).
 */
export function accountFailureOf(run: LedgerRun | undefined): AccountFailure | null {
  if (!run || (run.status !== 'failed' && run.status !== 'timed_out')) return null
  if (run.errorClass === 'Auth') return 'sign_in'
  if (run.errorClass === 'Billing') return 'billing'
  return null
}

/**
 * The class a run is filed under when a hard budget cap refused it (#319), or killed
 * it mid-run. Not one of the runtime error taxonomy's classes: nothing failed, the
 * host decided the run could not go on. Such a run may close `cancelled`, and it is
 * still not a person's Stop.
 */
export const BUDGET_REFUSED_CLASS = 'BudgetRefused'

/** Did a hard budget cap refuse or kill this run? */
export function budgetRefusalOf(run: LedgerRun | undefined): boolean {
  return run?.errorClass === BUDGET_REFUSED_CLASS
}

/**
 * Durable auto-refire cap: the ready-pump re-fires a released task until the
 * tail of its ledger holds this many consecutive runs that neither succeeded nor
 * were stopped by the user. The ledger IS the counter, so it survives restarts.
 */
export const MAX_AUTO_FIRES = 3

/** The statuses of a run that has not finished: no outcome yet. */
const UNFINISHED_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'queued', 'pending'])

/** Has this run ended? A run still going (or one that leaked as `running`
 *  behind a newer run) has no outcome to count. Shared with the attempt
 *  reader (`classifyAttempts` in @clawboo/db), so the two never disagree. */
export function isFinishedRun(status: string): boolean {
  return !UNFINISHED_RUN_STATUSES.has(status)
}

/**
 * How many runs at the END of the ledger ended without success and without a
 * user Stop (`failed`, `timed_out`, an orphan reaped as failed). A success or a
 * Stop in between resets the count, so a task that failed twice long ago is not
 * penalised forever. A run that never finished is skipped rather than counted:
 * it is no outcome, and counting it parked a task one run early.
 */
export function trailingFailedRuns(execs: readonly LedgerRun[]): number {
  let trailing = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const s = execs[i]!.status
    if (!isFinishedRun(s)) continue
    if (s === 'succeeded' || s === 'cancelled') break
    trailing += 1
  }
  return trailing
}

// ── The no-progress brake ───────────────────────────────────────────────────

/** Runs in a row with no visible progress before the brake engages. */
export const BRAKE_AFTER_RUNS = 2
/** The first wait, once it engages. Doubles with each further run. */
export const BRAKE_FIRST_WAIT_MS = 2 * 60_000
/** The longest wait. */
export const BRAKE_MAX_WAIT_MS = 30 * 60_000

/**
 * Did this run make VISIBLE PROGRESS on its task: something a person looking at
 * the board can see that was not there when the run started? Read when the run
 * closes, and stored on its ledger row, so the answer survives a restart.
 *
 * Yes when any of these holds:
 *   • a sub-task was created under the task during the run (whatever the outcome:
 *     work was handed on, so running it again is not the same run);
 *   • the run ended well and left a result;
 *   • the run ended well and the card moved forward (In review or Done).
 *
 * No for any other ending. Deliberately not counted: comments (the one thing two
 * agents could exchange forever, which is the loop this brake is for), tokens
 * spent, tool calls and files touched, none of which the board can see as work
 * done.
 *
 * Null, no verdict either way, for a run that says nothing about progress: a
 * person's Stop, an account refusal (parked until a person fixes it) and a hard
 * budget refusal (the run never started).
 */
export function runMadeProgress(run: {
  status: string
  summary?: string | null
  /** The task's status when the run closed. */
  taskStatus: string
  /** Sub-tasks created under the task since the run started. */
  subTasks: number
  errorClass?: string | null
}): boolean | null {
  if (run.status === 'cancelled') return null
  if (budgetRefusalOf({ status: run.status, errorClass: run.errorClass })) return null
  if (accountFailureOf({ status: run.status, errorClass: run.errorClass })) return null
  if (run.subTasks > 0) return true
  if (run.status !== 'succeeded') return false
  return !!run.summary?.trim() || run.taskStatus === 'done' || run.taskStatus === 'in_review'
}

/**
 * How many runs at the end of the ledger made no visible progress. Progress or a
 * person's Stop ends the streak. A run still going, a hard budget refusal and an
 * account refusal neither count nor end it. A run closed before the ledger
 * recorded a verdict reads from its outcome.
 */
export function trailingNoProgressRuns(execs: readonly LedgerRun[]): number {
  let trailing = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const run = execs[i]!
    if (!isFinishedRun(run.status)) continue
    if (budgetRefusalOf(run) || accountFailureOf(run)) continue
    if (run.status === 'cancelled') break
    const verdict = run.madeProgress
    const progress =
      verdict === null || verdict === undefined ? run.status === 'succeeded' : !!verdict
    if (progress) break
    trailing += 1
  }
  return trailing
}

/**
 * When the next automatic start of this task may happen, or null when the brake
 * is not engaged: after BRAKE_AFTER_RUNS runs in a row with no visible progress,
 * BRAKE_FIRST_WAIT_MS from the end of the last one, doubling with each further run
 * up to BRAKE_MAX_WAIT_MS. A ledger with no finish time waits for nothing.
 */
export function brakeUntil(execs: readonly LedgerRun[]): number | null {
  const runs = trailingNoProgressRuns(execs)
  if (runs < BRAKE_AFTER_RUNS) return null
  let lastEnd: number | null = null
  for (let i = execs.length - 1; i >= 0 && lastEnd === null; i--) {
    const run = execs[i]!
    if (!isFinishedRun(run.status) || budgetRefusalOf(run) || accountFailureOf(run)) continue
    lastEnd = run.completedAt ?? null
    break
  }
  if (lastEnd === null) return null
  const wait = BRAKE_FIRST_WAIT_MS * 2 ** (runs - BRAKE_AFTER_RUNS)
  return lastEnd + Math.min(wait, BRAKE_MAX_WAIT_MS)
}

/** Why the automatic pump will not start a task now. */
export type AutoFireRefusal =
  'running' | 'stopped' | 'sign_in' | 'billing' | 'budget' | 'failed_too_often' | 'braked'

/**
 * The ready-pump's fire policy over a task's ledger (oldest run first), naming why
 * it refuses, or null when the task may fire:
 *   • empty ledger → never delivered (fresh, deferred, assigned) → fire;
 *   • last run `running` → someone owns it → leave it;
 *   • last run refused or killed by a hard budget cap → it would be refused again
 *     until a person raises the cap;
 *   • last run `cancelled` → the user STOPPED it → never auto-refire (a person
 *     re-queues it deliberately);
 *   • last run refused by the provider for the account (sign-in or billing) →
 *     park it: every re-fire fails the same way until a person fixes it;
 *   • MAX_AUTO_FIRES consecutive unsuccessful runs at the tail → park it;
 *   • the no-progress brake is holding it back → it fires when the wait ends;
 *   • otherwise (timed out / failed / orphaned) → infrastructure death, not
 *     intent → re-fire.
 */
export function autoFireRefusal(
  execs: readonly LedgerRun[],
  now: number = Date.now(),
): AutoFireRefusal | null {
  if (execs.length === 0) return null
  const lastRun = execs[execs.length - 1]!
  if (lastRun.status === 'running') return 'running'
  if (budgetRefusalOf(lastRun)) return 'budget'
  if (lastRun.status === 'cancelled') return 'stopped'
  const account = accountFailureOf(lastRun)
  if (account) return account
  if (trailingFailedRuns(execs) >= MAX_AUTO_FIRES) return 'failed_too_often'
  const until = brakeUntil(execs)
  return until !== null && now < until ? 'braked' : null
}

/** May the automatic pump start this task now? */
export function ledgerAllowsAutoFire(
  execs: readonly LedgerRun[],
  now: number = Date.now(),
): boolean {
  return autoFireRefusal(execs, now) === null
}

/**
 * Will the pump ever start this task by itself? True for a task the brake is only
 * holding back; false for one parked until a person acts. What the needs-you
 * column and a delegator's "still outstanding" list ask: a braked task is not stuck.
 */
export function ledgerWillAutoFire(execs: readonly LedgerRun[]): boolean {
  return autoFireRefusal(execs, Number.POSITIVE_INFINITY) === null
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

/**
 * The agent a delegated task reports its result to, decoded from the
 * `:reflectTo:<id>` segment of its `sourceDelegationId`, or null when it names
 * none (a task a person assigned, a legacy manual card, an agent's own
 * `create_task`). The same segment the team engine writes and reads.
 */
export function delegatorOf(sourceDelegationId: string | null | undefined): string | null {
  if (!sourceDelegationId) return null
  return sourceDelegationId.match(/:reflectTo:([^:]+)/)?.[1] ?? null
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
