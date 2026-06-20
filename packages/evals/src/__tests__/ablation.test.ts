import { afterAll, describe, expect, it } from 'vitest'

import { runAblation } from '../ablation'
import { cleanupEvalContexts, makeBoardContext } from '../env'
import { ABLATION_TASKS } from '../tasks'

afterAll(() => cleanupEvalContexts())

describe('ablation scorecard (±verifier × ±structured-state)', () => {
  it('quantifies each subsystem’s marginal contribution', async () => {
    const card = await runAblation({
      tasks: ABLATION_TASKS,
      makeCtx: (flags) => Promise.resolve(makeBoardContext(flags)),
      trials: 2,
    })

    expect(card.cells).toHaveLength(4)
    // Full harness completes every capability task.
    expect(card.baselinePassAt1).toBe(1)

    // Removing EITHER subsystem drops the pass rate → positive marginal contribution.
    const verifier = card.contributions.find((c) => c.subsystem === 'verifier')!
    const structured = card.contributions.find((c) => c.subsystem === 'structured-state')!
    expect(verifier.deltaPassAt1).toBeGreaterThan(0)
    expect(structured.deltaPassAt1).toBeGreaterThan(0)

    // The "none" variant (both removed) is strictly worse than the baseline.
    const none = card.cells.find((c) => c.variant === 'none')!
    expect(none.passAt1).toBeLessThan(card.baselinePassAt1)

    // Each single-removal variant is between full and none (each subsystem earns
    // its place — neither is redundant on this task set).
    const noVerifier = card.cells.find((c) => c.variant === '-verifier')!
    const noStructured = card.cells.find((c) => c.variant === '-structured')!
    expect(noVerifier.passAt1).toBeLessThan(card.baselinePassAt1)
    expect(noStructured.passAt1).toBeLessThan(card.baselinePassAt1)
  })
})
