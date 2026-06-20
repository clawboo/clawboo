import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { getBudget, listBudgets, recordSpend, resumeBudget, setBudgetLimit } from '../budgets'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-budget-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('recordSpend (atomic budget kill-switch)', () => {
  it('returns null for an uncapped scope', () => {
    expect(recordSpend(db, 'agent', 'a1', 50)).toBeNull()
  })

  it('transitions active → soft_capped → paused and flags each crossing once', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1000, mode: 'cap' })
    expect(recordSpend(db, 'agent', 'a1', 700)).toMatchObject({
      status: 'active',
      spentUsdCents: 700,
      crossed: 'none',
    })
    expect(recordSpend(db, 'agent', 'a1', 150)).toMatchObject({
      status: 'soft_capped',
      spentUsdCents: 850,
      crossed: 'soft',
    })
    expect(recordSpend(db, 'agent', 'a1', 200)).toMatchObject({
      status: 'paused',
      spentUsdCents: 1050,
      crossed: 'hard',
    })
    // stays paused on further spend; no new crossing
    expect(recordSpend(db, 'agent', 'a1', 50)).toMatchObject({ status: 'paused', crossed: 'none' })
    expect(getBudget(db, 'agent', 'a1')?.spentUsdCents).toBe(1100)
  })

  it('sums many increments exactly (no lost updates)', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 100_000 })
    for (let i = 0; i < 200; i++) recordSpend(db, 'team', 't1', 1)
    expect(getBudget(db, 'team', 't1')?.spentUsdCents).toBe(200)
    expect(getBudget(db, 'team', 't1')?.status).toBe('active')
  })

  it('records mission(root-task) + team scopes independently', () => {
    setBudgetLimit(db, { scope: 'mission', scopeId: 'root1', limitUsdCents: 500, mode: 'cap' })
    setBudgetLimit(db, { scope: 'team', scopeId: 'tm1', limitUsdCents: 5000, mode: 'cap' })
    recordSpend(db, 'mission', 'root1', 600)
    recordSpend(db, 'team', 'tm1', 600)
    expect(getBudget(db, 'mission', 'root1')?.status).toBe('paused')
    expect(getBudget(db, 'team', 'tm1')?.status).toBe('active')
  })
})

describe('track-and-warn mode (the track-and-warn default posture)', () => {
  it('a cap budget reports mode:cap and reaches paused at 100%', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    expect(recordSpend(db, 'agent', 'a1', 150)).toMatchObject({
      status: 'paused',
      crossed: 'hard',
      mode: 'cap',
    })
  })

  it('a warn budget tracks spend + flags crossings but NEVER reads paused', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1000, mode: 'warn' })
    // 80% crossing still fires 'soft'.
    expect(recordSpend(db, 'agent', 'a1', 850)).toMatchObject({
      status: 'soft_capped',
      crossed: 'soft',
      mode: 'warn',
    })
    // 100%+ crossing still fires 'hard' — but the persisted status is clamped to
    // soft_capped (never 'paused'), so the executor kill-switch leaves it alone.
    const atLimit = recordSpend(db, 'agent', 'a1', 300)
    expect(atLimit?.crossed).toBe('hard')
    expect(atLimit?.status).not.toBe('paused')
    expect(getBudget(db, 'agent', 'a1')?.status).not.toBe('paused')
    expect(getBudget(db, 'agent', 'a1')?.spentUsdCents).toBe(1150) // spend still tracked exactly
  })

  it('defaults to mode:warn when mode is omitted (the locked track-and-warn posture)', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 100 })
    expect(getBudget(db, 'team', 't1')?.mode).toBe('warn')
    // Over the limit, a default budget records spend + flags the crossing but is
    // clamped to never read 'paused' — so it warns, it never auto-pauses.
    const over = recordSpend(db, 'team', 't1', 200)
    expect(over?.mode).toBe('warn')
    expect(over?.status).not.toBe('paused')
    expect(getBudget(db, 'team', 't1')?.status).not.toBe('paused')
  })

  it('re-setting mode flips a cap budget to warn (and stops it pausing)', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 150)
    expect(getBudget(db, 'agent', 'a1')?.status).toBe('paused')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'warn' })
    expect(getBudget(db, 'agent', 'a1')?.status).not.toBe('paused')
    expect(getBudget(db, 'agent', 'a1')?.mode).toBe('warn')
  })
})

describe('setBudgetLimit / resumeBudget (human override)', () => {
  it('raising the cap above spend un-pauses', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 150)
    expect(getBudget(db, 'agent', 'a1')?.status).toBe('paused')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 500 })
    expect(getBudget(db, 'agent', 'a1')?.status).toBe('active')
  })

  it('resumeBudget forces active and no-ops on an unknown scope', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 150)
    expect(resumeBudget(db, 'agent', 'a1')?.status).toBe('active')
    expect(getBudget(db, 'agent', 'a1')?.status).toBe('active')
    expect(resumeBudget(db, 'agent', 'nope')).toBeNull()
  })

  it('a BARE resume of an over-limit scope re-pauses on the next cost event', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 150) // paused, spent 150 > 100
    resumeBudget(db, 'agent', 'a1') // bare resume, no grace
    expect(getBudget(db, 'agent', 'a1')?.status).toBe('active')
    // The very next cost event re-pauses — this is why the route surfaces willRepause.
    expect(recordSpend(db, 'agent', 'a1', 1)?.status).toBe('paused')
  })

  it('resumeBudget with grace raises the cap above spend so progress is possible', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 150) // paused at spent 150
    const r = resumeBudget(db, 'agent', 'a1', { graceUsdCents: 50 })
    expect(r?.status).toBe('active')
    expect(r?.limitUsdCents).toBe(200) // spent 150 + grace 50
    // A small subsequent spend now makes progress instead of immediately re-pausing.
    expect(recordSpend(db, 'agent', 'a1', 10)?.status).not.toBe('paused')
  })

  it('carries sub-cent spend across events instead of flooring each to 0', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 'sub', limitUsdCents: 100_000 })
    // 100 × 0.4¢ ($0.004) — each rounds to 0 whole cents, but the micro-cent carry
    // accumulates to 40¢ (was silently dropped before).
    for (let i = 0; i < 100; i++) recordSpend(db, 'team', 'sub', 0.4)
    expect(getBudget(db, 'team', 'sub')?.spentUsdCents).toBe(40)
  })

  it('integer-cent deltas are unaffected by the micro-cent carry', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'int', limitUsdCents: 100_000 })
    expect(recordSpend(db, 'agent', 'int', 150)?.spentUsdCents).toBe(150)
    expect(recordSpend(db, 'agent', 'int', 25)?.spentUsdCents).toBe(175)
  })

  it('lists budgets and filters by scope', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 200 })
    expect(listBudgets(db)).toHaveLength(2)
    expect(listBudgets(db, { scope: 'team' })).toHaveLength(1)
  })
})
