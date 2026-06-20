import { describe, expect, it } from 'vitest'

import { checkCostCap, checkDepthCap, checkFanoutCap } from '../index'

describe('checkDepthCap', () => {
  it('allows below max, rejects at/over max', () => {
    expect(checkDepthCap({ depth: 0, max: 2 }).ok).toBe(true)
    expect(checkDepthCap({ depth: 1, max: 2 }).ok).toBe(true)
    expect(checkDepthCap({ depth: 2, max: 2 }).ok).toBe(false)
    expect(checkDepthCap({ depth: 3, max: 2 }).ok).toBe(false)
  })
})

describe('checkFanoutCap', () => {
  it('rejects once siblings have reached the cap', () => {
    expect(checkFanoutCap({ siblingCount: 2, max: 3 }).ok).toBe(true)
    expect(checkFanoutCap({ siblingCount: 3, max: 3 }).ok).toBe(false)
  })
})

describe('checkCostCap', () => {
  it('rejects at OR over the ceiling (matches the budget hard cap >=)', () => {
    expect(checkCostCap({ nodeCents: 999, max: 1000 }).ok).toBe(true)
    // At exactly the ceiling = enforced, identical to the budget kill-switch's
    // `spent >= limit` — the two cent ceilings treat the boundary the same way.
    expect(checkCostCap({ nodeCents: 1000, max: 1000 }).ok).toBe(false)
    expect(checkCostCap({ nodeCents: 1001, max: 1000 }).ok).toBe(false)
  })
})
