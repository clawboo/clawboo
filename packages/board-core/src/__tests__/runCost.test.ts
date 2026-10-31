import { describe, expect, it } from 'vitest'

import { RUN_COST_SOURCES, summarizeRunCost } from '../runCost'

describe('summarizeRunCost: a task costs the sum of its runs', () => {
  it('has no cost before any run', () => {
    expect(summarizeRunCost([])).toEqual({ usd: null, estimated: false })
  })

  it('ignores runs that recorded no cost, such as a recovery tombstone', () => {
    expect(
      summarizeRunCost([
        { costUsd: null, costSource: null },
        { costUsd: undefined, costSource: 'reported' },
        { costUsd: Number.NaN, costSource: 'reported' },
      ]),
    ).toEqual({ usd: null, estimated: false })
  })

  it('adds reported costs and vouches for the total', () => {
    const cost = summarizeRunCost([
      { costUsd: 0.1, costSource: 'reported' },
      { costUsd: 0.2, costSource: 'reported' },
    ])
    expect(cost.usd).toBeCloseTo(0.3, 10)
    expect(cost.estimated).toBe(false)
  })

  it('reads as an estimate when any run was estimated', () => {
    const cost = summarizeRunCost([
      { costUsd: 0.1, costSource: 'reported' },
      { costUsd: 0.02, costSource: 'token-estimate' },
    ])
    expect(cost.usd).toBeCloseTo(0.12, 10)
    expect(cost.estimated).toBe(true)
  })

  it('counts a cost with no recorded source as an estimate', () => {
    expect(summarizeRunCost([{ costUsd: 0.4, costSource: null }])).toEqual({
      usd: 0.4,
      estimated: true,
    })
    expect(summarizeRunCost([{ costUsd: 0.4 }])).toEqual({ usd: 0.4, estimated: true })
  })

  it('counts a reported $0 as a cost, not as no cost', () => {
    expect(summarizeRunCost([{ costUsd: 0, costSource: 'reported' }], 0.05)).toEqual({
      usd: 0,
      estimated: false,
    })
  })

  it("falls back to the task's legacy cost, as an estimate, when no run recorded one", () => {
    expect(summarizeRunCost([{ costUsd: null }], 0.05)).toEqual({ usd: 0.05, estimated: true })
  })

  it('shows nothing for a legacy cost of zero', () => {
    expect(summarizeRunCost([], 0)).toEqual({ usd: null, estimated: false })
    expect(summarizeRunCost([], null)).toEqual({ usd: null, estimated: false })
  })

  it('vouches for a run on a local model and marks a task that only ran locally as free', () => {
    expect(summarizeRunCost([{ costUsd: 0, costSource: 'local' }])).toEqual({
      usd: 0,
      estimated: false,
      local: true,
    })
  })

  it('is not free when any counted run was paid for', () => {
    expect(
      summarizeRunCost([
        { costUsd: 0, costSource: 'local' },
        { costUsd: 0.25, costSource: 'reported' },
      ]),
    ).toEqual({ usd: 0.25, estimated: false })
    expect(
      summarizeRunCost([
        { costUsd: 0, costSource: 'local' },
        { costUsd: 0.1, costSource: 'char-estimate' },
      ]),
    ).toEqual({ usd: 0.1, estimated: true })
  })

  it('names the four sources, most trustworthy first', () => {
    expect(RUN_COST_SOURCES).toEqual(['reported', 'local', 'token-estimate', 'char-estimate'])
  })
})
