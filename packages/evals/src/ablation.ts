// The ablation scorecard — the harness-health metric. Hold the model fixed,
// remove one subsystem at a time (±verifier × ±structured-state), and measure the
// drop in pass rate. The size of each drop estimates that subsystem's MARGINAL
// CONTRIBUTION for the current task set. A near-zero drop is NOT "useless" — it
// means redundant / unexercised on these tasks (lead with failure attribution).
// Re-run on each major model release: criticality migrates.

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
