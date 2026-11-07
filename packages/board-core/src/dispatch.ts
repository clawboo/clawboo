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
  /** Whether the team engine owns it: see {@link isEngineRun}. */
  engineRun?: number | boolean | null
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
  /** Why the run started (`TaskRunReason`). A person's run starts the provider
   *  retry count again. */
  runReason?: string | null
  /** 1 on a run whose process died with the previous server (`reconcileOrphans`). */
  recoveryTombstone?: number | null
}

/**
 * Is this run the team engine's own? The `engine_run` marker says. A row from before
 * that column has no marker, and then only the engine wrote the `openclaw` label it
 * carries. Any other row's label says nothing: the executions route takes any name, and
 * the engine's label is not the runtime that ran.
 */
export function isEngineRun(run: {
  engineRun?: number | boolean | null
  executorType?: string | null
}): boolean {
  if (run.engineRun === null || run.engineRun === undefined) return run.executorType === 'openclaw'
  return run.engineRun === 1 || run.engineRun === true
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

/**
 * Ledger statuses of their own for a run the host stopped. `cancelled` is a person's
 * word, so these are not it, and each reader below has to say what it does with them:
 *   • `budget_paused`   a hard cap refused the run or killed it. A person raises it;
 *   • `budget_held`     the cap's room is set aside by runs already going, which
 *                       clears by itself when they end;
 *   • `breaker_tripped` the circuit breaker stopped a run going wrong. A person looks.
 */
export const BUDGET_PAUSED_STATUS = 'budget_paused'
export const BUDGET_HELD_STATUS = 'budget_held'
export const BREAKER_TRIPPED_STATUS = 'breaker_tripped'

/** Did a hard budget cap refuse or kill this run? The class alone is how a row closed
 *  before the statuses existed says so. */
export function budgetRefusalOf(run: LedgerRun | undefined): boolean {
  return (
    run?.status === BUDGET_PAUSED_STATUS ||
    run?.status === BUDGET_HELD_STATUS ||
    run?.errorClass === BUDGET_REFUSED_CLASS
  )
}

/** The error the boot reap writes on a run whose process died with the previous
 *  server. Its row also carries `recoveryTombstone`. */
export const ORPHANED_RUN_ERROR = 'orphaned: process not alive on restart'

/** The error the stale sweep writes on a run whose drain stopped beating. Its row is
 *  `timed_out`, the status the team engine's watchdog writes too, so this text is what
 *  tells a crash from a timeout. */
export const STALE_RUN_ERROR = 'stale: no heartbeat within the watchdog window'

/** The stale sweep's error before 86ea611f, still on rows in older databases. */
const LEGACY_STALE_RUN_ERROR = 'stale: no progress within the watchdog window'

/** How a run ended, read from its row. `crash`: it never got to report. `timeout`: a
 *  watchdog stopped a run that had gone silent while its process lived. `error`: it
 *  ran and failed. `budget` and `breaker`: the host stopped it. `cancelled`: a person
 *  did, or a run closed because its task was already taken from it. */
export type RunKind = 'crash' | 'timeout' | 'error' | 'success' | 'cancelled' | 'budget' | 'breaker'

export function runKindOf(run: LedgerRun): RunKind {
  if (run.status === 'succeeded') return 'success'
  if (budgetRefusalOf(run)) return 'budget'
  if (run.status === BREAKER_TRIPPED_STATUS) return 'breaker'
  if (run.status === 'cancelled') return 'cancelled'
  if (run.recoveryTombstone === 1) return 'crash'
  if (run.status === 'timed_out')
    return run.error === STALE_RUN_ERROR || run.error === LEGACY_STALE_RUN_ERROR
      ? 'crash'
      : 'timeout'
  return 'error'
}

/** What the provider did to a run that a later try can get past by itself: it rate
 *  limited the account, or it was overloaded or out of reach. */
export type ProviderFailure = 'rate_limited' | 'unavailable'

/**
 * The provider failure a run ended on, or null. These are the taxonomy's transient
 * classes (`isTransientError` in @clawboo/obs), spelled out because this module imports
 * nothing (a test in @clawboo/db holds the two spellings together). A failure is read
 * from the class the runtime's own error was filed under, never from a run's prose.
 */
export function providerFailureOf(run: LedgerRun | undefined): ProviderFailure | null {
  if (!run || (run.status !== 'failed' && run.status !== 'timed_out')) return null
  if (run.errorClass === 'RateLimited') return 'rate_limited'
  if (run.errorClass === 'ProviderError' || run.errorClass === 'Timeout') return 'unavailable'
  return null
}

/**
 * Durable auto-refire caps: the ready-pump re-fires a released task until the tail of
 * its ledger holds this many runs that ran and failed (MAX_AUTO_FIRES), or this many
 * whose process died before they could report (MAX_CRASH_FIRES). Counted apart: a
 * server that keeps restarting says nothing about the task, and a task that keeps
 * failing says nothing about the server. The ledger IS the counter, so it survives
 * restarts.
 */
export const MAX_AUTO_FIRES = 3
export const MAX_CRASH_FIRES = 3

/** The automatic retries after a provider failure, and the awake time before each.
 *  Long enough for a network drop to clear: a retry seconds later loses to a Wi-Fi
 *  blip just as the first try did. */
export const PROVIDER_RETRY_WAITS_MS: readonly number[] = [30_000, 60_000]
export const MAX_PROVIDER_RETRIES = PROVIDER_RETRY_WAITS_MS.length

/** The least time between tries of a task whose budget room was held. */
export const BUDGET_HELD_RECHECK_MS = 30_000

/** The statuses of a run that has not finished: no outcome yet. */
const UNFINISHED_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'queued', 'pending'])

/** Has this run ended? A run still going (or one that leaked as `running`
 *  behind a newer run) has no outcome to count. Shared with the attempt
 *  reader (`classifyAttempts` in @clawboo/db), so the two never disagree. */
export function isFinishedRun(status: string): boolean {
  return !UNFINISHED_RUN_STATUSES.has(status)
}

/**
 * The class a run's ledger row carries when a pause stopped it (`status`
 * `cancelled`). What sets it apart from a person pressing Stop: that is a decision
 * about the task, this one is about when work may run, so the task comes back by
 * itself on resume. This row is also all the state a resume needs: a paused task
 * stays in its status, and the one a pause released (In progress to To do) says so
 * here, durably, with no status snapshot to keep.
 */
export const PAUSED_RUN_CLASS = 'Paused'

/** Did a pause stop this run? */
export function stoppedByPause(run: LedgerRun | undefined): boolean {
  return run?.status === 'cancelled' && run.errorClass === PAUSED_RUN_CLASS
}

/**
 * The runs at the END of the ledger that ended without success and without a user
 * Stop, by how they ended: `crashes` never got to report, `errors` ran and failed (a
 * watchdog's timeout among them). A success or a Stop in between resets the count, so
 * a task that failed twice long ago is not penalised forever, and so does a breaker
 * trip, which waits for a person to look. A run that never finished is skipped rather
 * than counted: it is no outcome, and counting it parked a task one run early. So is a
 * budget stop, which says nothing about the task's work, and a run a pause stopped.
 */
export function trailingRunFailures(execs: readonly LedgerRun[]): {
  crashes: number
  errors: number
} {
  let crashes = 0
  let errors = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const run = execs[i]!
    if (!isFinishedRun(run.status) || stoppedByPause(run)) continue
    const kind = runKindOf(run)
    if (kind === 'budget') continue
    if (kind === 'success' || kind === 'cancelled' || kind === 'breaker') break
    if (kind === 'crash') crashes += 1
    else errors += 1
  }
  return { crashes, errors }
}

/** How many runs at the end of the ledger did not succeed, of either kind: the count
 *  a card shows ("Failed 3×"). */
export function trailingFailedRuns(execs: readonly LedgerRun[]): number {
  const { crashes, errors } = trailingRunFailures(execs)
  return crashes + errors
}

/** The run reasons a person is behind (`TaskRunReason`): such a run starts the
 *  provider retry count again, since a person asked for it. */
const PERSON_RUN_REASONS: ReadonlySet<string> = new Set([
  'person_retry',
  'person_comment',
  'question_answered',
  'reopened',
])

/**
 * How many automatic retries the provider failures at the end of the ledger have used:
 * every failure in a row but the first. Read from the ledger, so it survives a restart.
 * Anything else ends the row, and a budget refusal or a run a pause stopped in the
 * middle neither counts nor ends it. A person's run is the first of a new row.
 */
export function providerRetriesUsed(execs: readonly LedgerRun[]): number {
  let failures = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const run = execs[i]!
    if (!isFinishedRun(run.status) || budgetRefusalOf(run) || stoppedByPause(run)) continue
    if (!providerFailureOf(run)) break
    failures += 1
    if (PERSON_RUN_REASONS.has(run.runReason ?? '')) break
  }
  return Math.max(0, failures - 1)
}

/** The run reasons that carry on what an earlier run began, by themselves. Any other
 *  reason is something new: a first delegation, a person asking, a wake. A task's
 *  follow-up carries on too: what its sub-tasks did is this work's, and an extra turn it
 *  already had stays had. */
const CARRYING_ON_REASONS: ReadonlySet<string> = new Set([
  'empty_reply',
  'max_turns',
  'provider_retry',
  'fix_round',
  'subtasks_closed',
])

/** Does a run of this reason carry on what an earlier run began? */
export function carriesOnEarlierRun(reason: string | null | undefined): boolean {
  return !!reason && CARRYING_ON_REASONS.has(reason)
}

/**
 * Has this stretch of work already had this extra turn? A stretch is the runs back to
 * whatever started it, so a retry or a fix round in between hands out no second one, and
 * the two kinds of extra turn cannot alternate: each is had once. Those turns start with
 * no pump in between, so this is all that bounds them. A person's run starts a new
 * stretch. `from` is the run to read back from, the last one by default.
 */
export function extraTurnUsed(
  execs: readonly LedgerRun[],
  reason: 'empty_reply' | 'max_turns',
  from: number = execs.length - 1,
): boolean {
  for (let i = from; i >= 0; i--) {
    const why = execs[i]?.runReason
    if (why === reason) return true
    if (!carriesOnEarlierRun(why)) return false
  }
  return false
}

/** When the stretch of work a run belongs to began (see {@link extraTurnUsed}), or null
 *  for an empty ledger or a row that does not say. What any of its runs did counts as
 *  this work's: a retry that repeats nothing still has the sub-task its first try made. */
export function stretchStartedAt(
  execs: readonly LedgerRun[],
  from: number = execs.length - 1,
): number | null {
  for (let i = from; i >= 0; i--) {
    if (i === 0 || !carriesOnEarlierRun(execs[i]?.runReason)) return execs[i]?.createdAt ?? null
  }
  return null
}

/**
 * When the next automatic retry of a provider failure may go, or null when the last
 * run was not one, its retries are used up, or the ledger holds no finish time. Wall
 * clock, so it holds across a restart. The engine that saw the failure also waits it
 * out in awake time, which leaves a sleeping laptop out of it.
 */
export function providerRetryUntil(execs: readonly LedgerRun[]): number | null {
  let last: LedgerRun | undefined
  for (let i = execs.length - 1; i >= 0 && !last; i--) {
    const run = execs[i]!
    if (isFinishedRun(run.status) && !budgetRefusalOf(run) && !stoppedByPause(run)) last = run
  }
  if (!providerFailureOf(last) || typeof last?.completedAt !== 'number') return null
  const used = providerRetriesUsed(execs)
  return used < MAX_PROVIDER_RETRIES ? last.completedAt + PROVIDER_RETRY_WAITS_MS[used]! : null
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
 * person's Stop, an account refusal (parked until a person fixes it), a hard
 * budget refusal (the run never started) and a provider failure (retried by itself).
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
  if (providerFailureOf({ status: run.status, errorClass: run.errorClass })) return null
  if (run.subTasks > 0) return true
  if (run.status !== 'succeeded') return false
  return !!run.summary?.trim() || run.taskStatus === 'done' || run.taskStatus === 'in_review'
}

/**
 * A reply with no text is EMPTY when the run has nothing else to show for itself. A
 * run that handed work on (a hand-off this turn, a sub-task it created), wrote its own
 * comment on the task or said how it went (`report_result`) reported some other way.
 * Files are not on this list: a run that changed the team's folder on a team with a
 * work check goes to that check, whose verdict is the evidence, and no other team's host
 * can see them.
 */
export function replyIsEmpty(run: {
  summary?: string | null
  /** Hand-offs this turn made. */
  handOffs: number
  /** Sub-tasks created under the task since the run started. */
  subTasks: number
  /** Comments the agent wrote on the task since the run started. */
  agentComments: number
  /** The agent reported on this run with `report_result`, either way. */
  reported?: boolean
}): boolean {
  return (
    !run.summary?.trim() &&
    run.handOffs === 0 &&
    run.subTasks === 0 &&
    run.agentComments === 0 &&
    !run.reported
  )
}

/**
 * How many runs at the end of the ledger made no visible progress. Progress or a
 * person's Stop ends the streak. A run still going, a hard budget refusal, an
 * account refusal, a provider failure and a run a pause stopped neither count nor end
 * it. A run closed before the ledger recorded a verdict reads from its outcome.
 */
export function trailingNoProgressRuns(execs: readonly LedgerRun[]): number {
  let trailing = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const run = execs[i]!
    if (!isFinishedRun(run.status)) continue
    if (
      budgetRefusalOf(run) ||
      accountFailureOf(run) ||
      providerFailureOf(run) ||
      stoppedByPause(run)
    )
      continue
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
    if (
      !isFinishedRun(run.status) ||
      budgetRefusalOf(run) ||
      accountFailureOf(run) ||
      providerFailureOf(run) ||
      stoppedByPause(run)
    )
      continue
    lastEnd = run.completedAt ?? null
    break
  }
  if (lastEnd === null) return null
  const wait = BRAKE_FIRST_WAIT_MS * 2 ** (runs - BRAKE_AFTER_RUNS)
  return lastEnd + Math.min(wait, BRAKE_MAX_WAIT_MS)
}

/** Why the automatic pump will not start a task now. */
export type AutoFireRefusal =
  | 'running'
  | 'stopped'
  | 'sign_in'
  | 'billing'
  | 'budget'
  | 'budget_held'
  | 'breaker'
  | 'failed_too_often'
  | 'retry_wait'
  | 'braked'

/**
 * The ready-pump's fire policy over a task's ledger (oldest run first), naming why
 * it refuses, or null when the task may fire:
 *   • empty ledger → never delivered (fresh, deferred, assigned) → fire;
 *   • last run `running` → someone owns it → leave it;
 *   • last run stopped by a pause → it was going, so it goes again on resume,
 *     whatever came before it (it may be a run a person asked for);
 *   • last run found its budget's room held by other runs → it clears by itself, so
 *     it fires again, BUDGET_HELD_RECHECK_MS after that try at the soonest;
 *   • last run refused or killed by a hard budget cap → it would be refused again
 *     until a person raises the cap;
 *   • last run stopped by the circuit breaker → a person looks at it first;
 *   • last run `cancelled` → the user STOPPED it → never auto-refire (a person
 *     re-queues it deliberately);
 *   • last run refused by the provider for the account (sign-in or billing) →
 *     park it: every re-fire fails the same way until a person fixes it;
 *   • MAX_AUTO_FIRES runs that failed, or MAX_CRASH_FIRES whose process died, at the
 *     tail → park it;
 *   • last run hit a provider failure with a retry left → it fires when its wait ends;
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
  if (stoppedByPause(lastRun)) return null
  if (lastRun.status === 'running') return 'running'
  if (lastRun.status === BUDGET_HELD_STATUS) {
    const tried = lastRun.completedAt
    if (typeof tried === 'number' && now < tried + BUDGET_HELD_RECHECK_MS) return 'budget_held'
  } else if (budgetRefusalOf(lastRun)) return 'budget'
  if (lastRun.status === BREAKER_TRIPPED_STATUS) return 'breaker'
  if (lastRun.status === 'cancelled') return 'stopped'
  const account = accountFailureOf(lastRun)
  if (account) return account
  const { crashes, errors } = trailingRunFailures(execs)
  if (crashes >= MAX_CRASH_FIRES || errors >= MAX_AUTO_FIRES) return 'failed_too_often'
  const retryAt = providerRetryUntil(execs)
  if (retryAt !== null && now < retryAt) return 'retry_wait'
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
 * Will the pump ever start this task by itself? True for a task the brake or a wait
 * is only holding back; false for one parked until a person acts. What the needs-you
 * column and a delegator's "still outstanding" list ask: a braked task is not stuck.
 */
export function ledgerWillAutoFire(execs: readonly LedgerRun[]): boolean {
  return autoFireRefusal(execs, Number.POSITIVE_INFINITY) === null
}

/** What the delegation failure breaker counts one agent's failures on one task under. */
export function delegationFailureKey(targetAgentId: string, task: string): string {
  return `${targetAgentId}:${task.slice(0, 80).toLowerCase().trim()}`
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
