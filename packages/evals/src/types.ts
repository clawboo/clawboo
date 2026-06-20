// The eval harness for clawboo's OWN orchestration — an eval is just a harness
// turned inward on measurement. A task gives the orchestration an input, runs it
// against a clean board, then GRADES the final environment state (the board) and
// the event log, not the narration. Graders come in three families (code / model /
// human); a trial is one attempt; we report pass@1 (≥1 success) AND pass^k (all k
// succeed) because consistency is the production bar. The harness is also the
// substrate for the ablation scorecard (±verifier × ±structured-state).

import type { ClawbooDb } from '@clawboo/db'

export type EvalSuite = 'capability' | 'regression'
export type EvalKind = 'coding' | 'research' | 'coordination'

/** The two harness subsystems the ablation toggles (the cross-runtime verification
 *  subsystem + the durable board / cross-runtime structured state). A task that depends on a
 *  subsystem reads the flag and behaves accordingly, so removing it measurably
 *  drops the pass rate — controlled-variable exclusion. */
export interface EvalFlags {
  verify: boolean
  structuredState: boolean
}

export interface EvalContext {
  /** A throwaway board db — each trial gets a CLEAN one (isolation). */
  db: ClawbooDb
  /** Which harness subsystems are present this trial. */
  flags: EvalFlags
}

/** The final environment state at the end of a trial (the OUTCOME, not the claim). */
export interface TrialOutcome {
  summary?: string
  data?: Record<string, unknown>
}

export interface GraderResult {
  name: string
  passed: boolean
  /** 0..1 — partial credit (an agent that did half the task scores 0.5). */
  score: number
  detail?: string
}

export type Grader = (
  ctx: EvalContext,
  outcome: TrialOutcome,
) => GraderResult | Promise<GraderResult>

export interface EvalTask {
  id: string
  suite: EvalSuite
  kind: EvalKind
  description: string
  /** Build the clean environment + drive the orchestration → the final outcome. */
  run: (ctx: EvalContext) => Promise<TrialOutcome>
  graders: Grader[]
  /** A note proving the task is solvable (a reference solution exists). */
  referenceNote?: string
  /** 'binary' = all graders must pass; 'weighted' = mean score ≥ threshold. */
  scoring?: 'binary' | 'weighted'
  threshold?: number
  /** Cheap + deterministic → runs in the PR smoke subset (no live model). */
  smoke?: boolean
  tags?: string[]
}

export interface Trial {
  taskId: string
  passed: boolean
  score: number
  graders: GraderResult[]
}

export interface TaskReport {
  taskId: string
  suite: EvalSuite
  kind: EvalKind
  trials: Trial[]
  /** Per-trial success rate = empirical pass@1. */
  passAt1: number
  /** Probability all k trials pass = passAt1^k (the configured k). */
  passPowK: number
  /** Mean partial-credit score across trials. */
  meanScore: number
}

export interface SuiteReport {
  tasks: TaskReport[]
  /** Macro-averaged pass@1 across tasks. */
  passAt1: number
  /** Macro-averaged pass^k across tasks. */
  passPowK: number
  k: number
}
