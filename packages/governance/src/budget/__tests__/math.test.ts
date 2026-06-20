import { describe, expect, it } from 'vitest'

import {
  budgetStatusAfter,
  centsToUsd,
  MICRO_CENTS_PER_CENT,
  softThresholdCents,
  statusForSpend,
  usdToCents,
  usdToFractionalCents,
} from '../index'

describe('usdToCents / centsToUsd', () => {
  it('rounds USD to non-negative cents', () => {
    expect(usdToCents(0.26)).toBe(26)
    expect(usdToCents(2.5)).toBe(250)
    expect(usdToCents(0)).toBe(0)
    expect(usdToCents(-5)).toBe(0)
    expect(usdToCents(Number.NaN)).toBe(0)
    expect(centsToUsd(250)).toBe(2.5)
  })
  it('a sub-half-cent amount ROUNDS to 0 cents (why the ledger must not use this)', () => {
    expect(usdToCents(0.004)).toBe(0)
  })
})

describe('usdToFractionalCents (the budget ledger conversion)', () => {
  it('does NOT round — a sub-cent amount keeps its fraction', () => {
    expect(usdToFractionalCents(0.004)).toBeCloseTo(0.4, 10)
    expect(usdToFractionalCents(2.5)).toBe(250)
    expect(usdToFractionalCents(0)).toBe(0)
    expect(usdToFractionalCents(-5)).toBe(0)
    expect(usdToFractionalCents(Number.NaN)).toBe(0)
  })
  it('100 sub-cent events accumulate to whole cents (no silent loss)', () => {
    // 100 × $0.004 = $0.40 = 40¢. In micro-cents, 0.4¢ = 4000µ¢; ×100 = 400000µ¢ = 40¢.
    const totalMicro = Array.from({ length: 100 }, () =>
      Math.round(usdToFractionalCents(0.004) * MICRO_CENTS_PER_CENT),
    ).reduce((a, b) => a + b, 0)
    expect(Math.floor(totalMicro / MICRO_CENTS_PER_CENT)).toBe(40)
  })
})

describe('softThresholdCents / statusForSpend', () => {
  it('uses integer-division 80% (mirrors the SQL CASE)', () => {
    expect(softThresholdCents(1000)).toBe(800)
    expect(softThresholdCents(999)).toBe(799)
  })
  it('maps spend to status at the boundaries', () => {
    expect(statusForSpend(1000, 0)).toBe('active')
    expect(statusForSpend(1000, 799)).toBe('active')
    expect(statusForSpend(1000, 800)).toBe('soft_capped')
    expect(statusForSpend(1000, 999)).toBe('soft_capped')
    expect(statusForSpend(1000, 1000)).toBe('paused')
    expect(statusForSpend(1000, 5000)).toBe('paused')
    expect(statusForSpend(0, 50)).toBe('active') // no/zero limit ⇒ uncapped
  })
})

describe('budgetStatusAfter', () => {
  it('flags the soft crossing exactly once', () => {
    expect(budgetStatusAfter({ limitCents: 1000, spentCents: 700, deltaCents: 150 })).toEqual({
      status: 'soft_capped',
      crossed: 'soft',
      newSpentCents: 850,
    })
    expect(budgetStatusAfter({ limitCents: 1000, spentCents: 850, deltaCents: 50 })).toEqual({
      status: 'soft_capped',
      crossed: 'none',
      newSpentCents: 900,
    })
  })
  it('flags the hard crossing (auto-pause) exactly once', () => {
    expect(budgetStatusAfter({ limitCents: 1000, spentCents: 900, deltaCents: 200 })).toEqual({
      status: 'paused',
      crossed: 'hard',
      newSpentCents: 1100,
    })
    expect(budgetStatusAfter({ limitCents: 1000, spentCents: 1100, deltaCents: 50 })).toEqual({
      status: 'paused',
      crossed: 'none',
      newSpentCents: 1150,
    })
  })
  it('jumps straight to hard when a single delta overshoots both tiers', () => {
    expect(budgetStatusAfter({ limitCents: 1000, spentCents: 500, deltaCents: 600 })).toEqual({
      status: 'paused',
      crossed: 'hard',
      newSpentCents: 1100,
    })
  })
})
