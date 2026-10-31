// How the board formats a task's run cost: the card and the drawer both read these,
// so a reported $0 never reads as missing and an estimate is always marked.

import { describe, expect, it } from 'vitest'

import { formatCostUsd, formatRunCost, runCostOf } from '../taskCost'

describe('formatCostUsd', () => {
  it('never rounds a real sub-cent charge down to $0.000', () => {
    expect(formatCostUsd(0)).toBe('$0.000')
    expect(formatCostUsd(0.0004)).toBe('$0.0004')
    expect(formatCostUsd(0.42)).toBe('$0.42')
  })
})

describe('formatRunCost', () => {
  it('shows a reported cost as a plain figure, including a reported $0', () => {
    expect(formatRunCost(0, false)).toBe('$0.000')
    expect(formatRunCost(0.42, false)).toBe('$0.42')
  })

  it('marks an estimate', () => {
    expect(formatRunCost(0.02, true)).toBe('~$0.02 est.')
  })

  it('shows four decimals when precise', () => {
    expect(formatRunCost(0.0042, true, { precise: true })).toBe('~$0.0042 est.')
    expect(formatRunCost(0.12, false, { precise: true })).toBe('$0.1200')
  })

  it('shows work that only ran on a local model as free, never as an estimate', () => {
    expect(formatRunCost(0, false, { local: true })).toBe('free')
    expect(formatRunCost(0, false, { local: true, precise: true })).toBe('free')
  })
})

describe('runCostOf', () => {
  it("reads the server's runCost when the task carries one", () => {
    expect(
      runCostOf({ id: 't1', status: 'done', costUsd: 0, runCost: { usd: 0, estimated: false } }),
    ).toEqual({ usd: 0, estimated: false })
    expect(
      runCostOf({ id: 't1', status: 'todo', runCost: { usd: null, estimated: false } }),
    ).toEqual({ usd: null, estimated: false })
  })

  it('records no cost for a task without runCost whose own cost is 0', () => {
    expect(runCostOf({ id: 't1', status: 'todo', costUsd: 0 })).toEqual({
      usd: null,
      estimated: false,
    })
    expect(runCostOf({ id: 't1', status: 'todo' })).toEqual({ usd: null, estimated: false })
  })

  it("shows a legacy task's own cost as an estimate", () => {
    expect(runCostOf({ id: 't1', status: 'done', costUsd: 0.05 })).toEqual({
      usd: 0.05,
      estimated: true,
    })
  })

  it('ignores a malformed runCost and falls back to the task cost', () => {
    expect(runCostOf({ id: 't1', status: 'done', costUsd: 0.05, runCost: { usd: '0.3' } })).toEqual(
      { usd: 0.05, estimated: true },
    )
  })
})
