// The server side of budget holds: what a run holds, how a refusal reads, that a
// ledger that cannot be read lets the run go, and the boot sweep that drops the
// holds of a server that is gone while keeping a live one's.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  budgetReservations,
  costRecords,
  createDb,
  recordSpend,
  reserveBudgets,
  setBudgetLimit,
  type ClawbooDb,
} from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { estimateRunReserveCents, reserveRunBudget, sweepBudgetHoldsAtBoot } from '../budgetHold'
import { budgetRefusalText } from '../budgetPreflight'
import { DEFAULTS } from '../defaults'

let dir: string
let db: ClawbooDb
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-budget-hold-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

const holds = () => db.select().from(budgetReservations).all()

function seedAgent(id: string): void {
  db.insert(agents)
    .values({ id, name: id, gatewayId: id, status: 'idle', createdAt: 0, updatedAt: 0 })
    .run()
}

describe('estimateRunReserveCents', () => {
  it('holds the default for an agent with no recorded runs', () => {
    expect(estimateRunReserveCents(db, 'a1')).toBe(DEFAULTS.budgetReserveDefaultUsdCents)
    expect(estimateRunReserveCents(db, null)).toBe(DEFAULTS.budgetReserveDefaultUsdCents)
  })

  it('holds the most any of its latest runs cost', () => {
    seedAgent('a1')
    const costs = [0.02, 0.4, 0.07]
    costs.forEach((costUsd, i) =>
      db
        .insert(costRecords)
        .values({
          agentId: 'a1',
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          costUsd,
          createdAt: 1_000 + i,
        })
        .run(),
    )
    expect(estimateRunReserveCents(db, 'a1')).toBeCloseTo(40, 6)
  })

  it('reads only the latest runs', () => {
    seedAgent('a1')
    // An old expensive run, then a full window of cheap ones.
    db.insert(costRecords)
      .values({
        agentId: 'a1',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 9,
        createdAt: 1,
      })
      .run()
    for (let i = 0; i < DEFAULTS.budgetReserveHistoryRuns; i++)
      db.insert(costRecords)
        .values({
          agentId: 'a1',
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0.01,
          createdAt: 100 + i,
        })
        .run()
    expect(estimateRunReserveCents(db, 'a1')).toBeCloseTo(1, 6)
  })
})

describe('reserveRunBudget', () => {
  it('takes no hold when no budget applies', () => {
    const gate = reserveRunBudget(db, { agentId: 'a1', teamId: 't1' }, { kind: 'task' })
    expect(gate.blocked).toBe(false)
    expect(holds()).toEqual([])
  })

  it('names the scope and the reason when a run is refused', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 't1', 95)
    const first = reserveRunBudget(db, { teamId: 't1' }, { kind: 'task', estimateCents: 10 })
    const second = reserveRunBudget(db, { teamId: 't1' }, { kind: 'task', estimateCents: 10 })
    expect(first.blocked).toBe(false)
    expect(second).toEqual({ blocked: true, scope: 'team', reason: 'held' })
    if (!first.blocked) first.hold.release()
    expect(holds()).toEqual([])
  })

  it('lets the run go without a hold when the ledger cannot be read', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    db.$client.exec('DROP TABLE budget_reservations')
    const gate = reserveRunBudget(db, { agentId: 'a1' }, { kind: 'chat' })
    expect(gate.blocked).toBe(false)
    if (gate.blocked) return
    expect(gate.hold.id).toBeNull()
    expect(gate.hold.recheck()).toEqual({ blocked: false })
    gate.hold.release()
  })
})

describe('budgetRefusalText', () => {
  it('says what stopped the run, in both cases', () => {
    expect(budgetRefusalText('team')).toMatch(/^The team budget is paused at its hard cap/)
    expect(budgetRefusalText('agent', 'held')).toMatch(
      /^The agent budget is close to its hard cap, and runs already going have set aside the rest of it/,
    )
  })
})

describe('sweepBudgetHoldsAtBoot', () => {
  const now = 50_000_000
  function holdFor(owner: { pid: number; startedAt: number } | null, createdAt = now): string {
    const r = reserveBudgets(db, {
      scopes: [{ scope: 'agent', scopeId: 'a1' }],
      estimateCents: 10,
      runKind: 'task',
      owner,
      now: createdAt,
    })
    if (!r.ok) throw new Error('refused')
    return r.holdId
  }
  const left = () => new Set(holds().map((h) => h.holdId))

  beforeEach(() => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 10_000, mode: 'cap' })
  })

  it("drops a stopped server's holds after a restart, so its budget is free again", () => {
    // A server held two runs and was killed; its pid is free now.
    holdFor({ pid: 999_001, startedAt: 1_000 })
    holdFor({ pid: 999_001, startedAt: 1_000 })
    const swept = sweepBudgetHoldsAtBoot(db, { isAlive: () => false, now })
    expect(swept).toBe(2)
    expect(holds()).toEqual([])
  })

  it("keeps a live second server's holds, and drops one whose pid now names another process", () => {
    const live = holdFor({ pid: 999_002, startedAt: 2_000_000 })
    const reused = holdFor({ pid: 999_003, startedAt: 3_000_000 })
    const swept = sweepBudgetHoldsAtBoot(db, {
      isAlive: () => true,
      startTimes: () => ({
        ok: true,
        times: new Map([
          [999_002, 2_000_500],
          // Started long after the hold was taken: not the server that took it.
          [999_003, 9_000_000],
        ]),
      }),
      now,
    })
    expect(swept).toBe(1)
    expect(left()).toEqual(new Set([live]))
    expect(left().has(reused)).toBe(false)
  })

  it('drops when it cannot tell, and drops holds that name no server or are too old', () => {
    holdFor({ pid: 999_004, startedAt: 4_000 })
    holdFor(null)
    holdFor({ pid: 999_005, startedAt: 5_000 }, 1)
    const swept = sweepBudgetHoldsAtBoot(db, {
      isAlive: (pid) => pid === 999_005 || pid === 999_004,
      startTimes: (pids) =>
        pids.includes(999_004)
          ? { ok: false, times: new Map(), error: 'ps: not found' }
          : { ok: true, times: new Map([[999_005, 5_000]]) },
      now,
    })
    expect(swept).toBe(3)
    expect(holds()).toEqual([])
  })

  it("keeps this server's own holds", () => {
    const gate = reserveRunBudget(db, { agentId: 'a1' }, { kind: 'task' })
    expect(gate.blocked).toBe(false)
    expect(sweepBudgetHoldsAtBoot(db, { isAlive: () => false, now: Date.now() })).toBe(0)
    expect(holds()).toHaveLength(1)
  })
})
