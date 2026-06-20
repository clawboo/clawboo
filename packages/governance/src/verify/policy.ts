import type {
  CriticVerdict,
  DeterministicResult,
  Finding,
  Severity,
  VerificationStatus,
} from './schemas'

// Rationed blocking: only these severities force a fix back to the specialist.
// style / perf / other are debt — recorded, never deadlocking.
const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  'security',
  'crash',
  'data_loss',
  'wrong_algorithm',
  'missing_ac',
])

export function classifySeverity(finding: Finding): 'block' | 'warn' {
  return BLOCKING_SEVERITIES.has(finding.severity) ? 'block' : 'warn'
}

export function blockingFindings(verdict: CriticVerdict): Finding[] {
  return verdict.findings.filter((f) => classifySeverity(f) === 'block')
}

export function isBlocking(verdict: CriticVerdict): boolean {
  return blockingFindings(verdict).length > 0
}

/**
 * Compose a single attempt's status from the two layers. The deterministic gate
 * is the hard signal: a red gate is always `fail`. A green gate plus a critic
 * with a blocking finding is also `fail` (route the fix back). Green + (critic
 * not run, or only non-blocking findings) is `pass`. `completed_with_debt` is a
 * loop-exhaustion decision (see {@link nextCycleDecision}), never produced here.
 */
export function verificationStatusFor(
  det: DeterministicResult,
  critic: CriticVerdict,
): Extract<VerificationStatus, 'pass' | 'fail'> {
  if (!det.passed) return 'fail'
  if (critic.ran && isBlocking(critic)) return 'fail'
  return 'pass'
}

export interface CycleInput {
  /** 1-based count of attempts INCLUDING the one just completed. */
  attempt: number
  /** Max verify-fix cycles before the loop is bounded out. */
  maxCycles: number
}

/**
 * After a failing attempt, decide whether to retry the fix loop or stop and mark
 * the task `completed_with_debt` (never deadlock). The independent evaluator is
 * permanent; only the *retry budget* is bounded.
 */
export function nextCycleDecision({ attempt, maxCycles }: CycleInput): 'retry' | 'mark_debt' {
  return attempt >= Math.max(1, maxCycles) ? 'mark_debt' : 'retry'
}

export const DEFAULT_MAX_FIX_CYCLES = 3

/** The loose shape the promotability check reads — a parsed verification cell may
 *  be partial / unvalidated (the board gate reads it inline), so every field is
 *  optional and the check defaults to NOT promotable on anything missing. */
interface PromotableVerdict {
  status?: VerificationStatus | string
  attempts?: { deterministic?: { passed?: boolean } }[]
}

/**
 * Can a task carrying this verdict reach `done`? The single rule shared by the
 * board state machine and the worktree completion path so "done means verified"
 * is enforced everywhere:
 *   - `pass` → yes.
 *   - `completed_with_debt` → only if the latest attempt's DETERMINISTIC gate was
 *     green (debt covers unresolved critic findings, NEVER a failing build/test
 *     gate — a red gate is the canonical crash/blocking case and must route to a
 *     human, not silently land as `done`).
 *   - anything else (`fail`, missing) → no.
 * A task with NO verdict is unverified, not failing — that is the caller's
 * concern (the gate only blocks when a non-promotable verdict EXISTS).
 */
export function isVerdictPromotable(verdict: PromotableVerdict | null | undefined): boolean {
  if (!verdict) return false
  if (verdict.status === 'pass') return true
  if (verdict.status === 'completed_with_debt') {
    const last = verdict.attempts?.[verdict.attempts.length - 1]
    return last?.deterministic?.passed === true
  }
  return false
}
