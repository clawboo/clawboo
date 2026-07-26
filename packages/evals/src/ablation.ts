// The ablation scorecard — a HARNESS SELF-TEST, not a measurement of the live
// orchestrator. Hold the harness fixed and toggle its two subsystem FLAGS
// (±verifier × ±structured-state); the capability tasks read those flags and behave
// accordingly, so each "marginal contribution" here is the harness's own scripted
// response to the flag — it confirms the ablation wiring is sound, nothing more.
// Measuring the REAL subsystems' contribution needs the live executor: apps/web's
// executorRunner integration test drives it deterministically today, and a
// live-model version is the deferred canary. The structure is kept so that canary can
// plug a real per-subsystem run in here.

import { runSuite } from './runner'
import type { EvalContext, EvalFlags, EvalTask } from './types'

export interface AblationCell {
  variant: string
  flags: EvalFlags
  passAt1: number
  passPowK: number
}

export interface AblationContribution {
  subsystem: 'verifier' | 'structured-state'
  /** Mean drop in pass@1 when the subsystem is removed (averaged over the other). */
  deltaPassAt1: number
}

export interface AblationScorecard {
  /** Full harness (both subsystems on). */
  baselinePassAt1: number
  cells: AblationCell[]
  contributions: AblationContribution[]
  trials: number
}

interface Variant {
  id: string
  flags: EvalFlags
}

const VARIANTS: Variant[] = [
  { id: 'full', flags: { verify: true, structuredState: true } },
  { id: '-verifier', flags: { verify: false, structuredState: true } },
  { id: '-structured', flags: { verify: true, structuredState: false } },
  { id: 'none', flags: { verify: false, structuredState: false } },
]

export interface RunAblationOptions {
  tasks: EvalTask[]
  /** Build a CLEAN ctx carrying the variant's flags (a fresh board per trial). */
  makeCtx: (flags: EvalFlags) => Promise<EvalContext>
  trials?: number
}

export async function runAblation(opts: RunAblationOptions): Promise<AblationScorecard> {
  const trials = opts.trials ?? 3
  const cells: AblationCell[] = []
  for (const v of VARIANTS) {
    const report = await runSuite(opts.tasks, () => opts.makeCtx(v.flags), { trials })
    cells.push({
      variant: v.id,
      flags: v.flags,
      passAt1: report.passAt1,
      passPowK: report.passPowK,
    })
  }
  const at = (id: string): number => cells.find((c) => c.variant === id)?.passAt1 ?? 0

  // Marginal contribution = pass(present) − pass(removed), averaged over the
  // OTHER subsystem's two settings (controlled-variable exclusion).
  const verifierDelta = (at('full') - at('-verifier') + (at('-structured') - at('none'))) / 2
  const structuredDelta = (at('full') - at('-structured') + (at('-verifier') - at('none'))) / 2

  return {
    baselinePassAt1: at('full'),
    cells,
    contributions: [
      { subsystem: 'verifier', deltaPassAt1: verifierDelta },
      { subsystem: 'structured-state', deltaPassAt1: structuredDelta },
    ],
    trials,
  }
}
