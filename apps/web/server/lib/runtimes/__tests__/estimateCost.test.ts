import { describe, expect, it } from 'vitest'

import { estimateRunCostUsdFromUsage } from '../estimateCost'

describe('estimateRunCostUsdFromUsage', () => {
  it('prices a known model from EXACT token usage (no char guess)', () => {
    // claude-haiku-4-5 in the shared rate table: $0.25/M in, $1.25/M out.
    const usd = estimateRunCostUsdFromUsage({
      model: 'claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(usd).toBeCloseTo(0.25 + 1.25, 6)
  })

  it('falls back to the default rate for an UNPRICED model (> 0 so the cap still engages)', () => {
    // gpt-5-codex / unpinned-native models are not in the table → default rate.
    expect(
      estimateRunCostUsdFromUsage({
        model: 'gpt-5-codex',
        inputTokens: 100_000,
        outputTokens: 100_000,
      }),
    ).toBeGreaterThan(0)
  })

  it('treats a null/empty model as the default rate', () => {
    expect(
      estimateRunCostUsdFromUsage({ model: null, inputTokens: 1000, outputTokens: 1000 }),
    ).toBeGreaterThan(0)
  })

  it('returns 0 for zero usage (no usage ⇒ no spend)', () => {
    expect(
      estimateRunCostUsdFromUsage({ model: 'gpt-5-codex', inputTokens: 0, outputTokens: 0 }),
    ).toBe(0)
  })
})
