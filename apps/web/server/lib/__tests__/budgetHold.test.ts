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

import { estimateRunReserveCents, reserveRunBudget, sweepLeftoverBudgetHolds } from '../budgetHold'
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

describe('estimateRunReserveCents: a run is its records summed', () => {
  function record(costUsd: number, runId: string | null, createdAt: number): void {
    db.insert(costRecords)
      .values({
        agentId: 'oc',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        costUsd,
        runId,
        createdAt,
      })
      .run()
  }

  it('adds up an OpenClaw run recorded turn by turn', () => {
    seedAgent('oc')
    // One run of 16 turns at 5 cents, recorded as 16 rows that share its run id.
    for (let i = 0; i < 16; i++) record(0.05, 'gw-run-1', 1_000 + i)
    expect(estimateRunReserveCents(db, 'oc')).toBeCloseTo(80, 6)
  })

  it('counts a record with no run id as a run of its own', () => {
    seedAgent('oc')
    record(0.05, null, 1)
    record(0.07, null, 2)
    expect(estimateRunReserveCents(db, 'oc')).toBeCloseTo(7, 6)
  })

  it('never joins a run id to a record id', () => {
    seedAgent('oc')
    record(0.05, null, 1) // row id 1
    record(0.04, '1', 2) // a run whose id reads "1"
    expect(estimateRunReserveCents(db, 'oc')).toBeCloseTo(5, 6)
  })

  it('reads only the latest runs, however many turns each had', () => {
    seedAgent('oc')
    record(9, 'old-run', 1)
    for (let r = 0; r < 10; r++)
      for (let t = 0; t < 3; t++) record(0.01, `run-${r}`, 100 + r * 10 + t)
    expect(estimateRunReserveCents(db, 'oc')).toBeCloseTo(3, 6)
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

describe('reserveRunBudget when the ledger fails', () => {
  it('still refuses a paused cap when the hold cannot be written', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 't1', 150)
    db.$client.exec('DROP TABLE budget_reservations')
    expect(reserveRunBudget(db, { agentId: 'a1', teamId: 't1' }, { kind: 'task' })).toEqual({
      blocked: true,
      scope: 'team',
      reason: 'paused',
    })
  })

  it('the final gate still refuses a cap that paused, when the hold cannot be read', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    const gate = reserveRunBudget(db, { agentId: 'a1' }, { kind: 'task', estimateCents: 10 })
    if (gate.blocked) throw new Error('refused')
    recordSpend(db, 'agent', 'a1', 150)
    db.$client.exec('DROP TABLE budget_reservations')
    expect(gate.hold.recheck()).toEqual({ blocked: true, scope: 'agent', reason: 'paused' })
  })

  it('lets the run go when neither the hold nor the budgets can be read', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    db.$client.exec('DROP TABLE budget_reservations')
    db.$client.exec('DROP TABLE budgets')
    const gate = reserveRunBudget(db, { agentId: 'a1' }, { kind: 'task' })
    expect(gate.blocked).toBe(false)
  })

  it('retries a release whose delete failed at the next admission', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1000, mode: 'cap' })
    const gate = reserveRunBudget(db, { agentId: 'a1' }, { kind: 'task', estimateCents: 10 })
    if (gate.blocked) throw new Error('refused')
    db.$client.exec(
      "CREATE TRIGGER no_delete BEFORE DELETE ON budget_reservations BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
    )
    gate.hold.release()
    expect(holds()).toHaveLength(1)
    db.$client.exec('DROP TRIGGER no_delete')
    // The next run's admission clears it before reading the room left.
    const next = reserveRunBudget(db, { agentId: 'a1' }, { kind: 'task', estimateCents: 10 })
    if (next.blocked) throw new Error('refused')
    expect(holds().map((h) => h.holdId)).toEqual([next.hold.id])
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

describe('sweepLeftoverBudgetHolds', () => {
  beforeEach(() => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 10_000, mode: 'cap' })
  })

  it("drops a stopped server's holds at start, so its budget is free again", () => {
    // A server held two runs and was killed mid-run.
    for (const pid of [999_001, 999_001]) {
      reserveBudgets(db, {
        scopes: [{ scope: 'agent', scopeId: 'a1' }],
        estimateCents: 10,
        runKind: 'task',
        owner: { pid, startedAt: 1_000 },
      })
    }
    sweepLeftoverBudgetHolds(db)
    expect(holds()).toEqual([])
  })

  it("keeps this server's own holds", () => {
    const gate = reserveRunBudget(db, { agentId: 'a1' }, { kind: 'task' })
    expect(gate.blocked).toBe(false)
    sweepLeftoverBudgetHolds(db)
    expect(holds()).toHaveLength(1)
  })

  it('tries a failed sweep again until it succeeds, and stops trying after the limit', () => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    let calls = 0
    sweepLeftoverBudgetHolds(db, {
      retryMs: 1_000,
      maxTries: 5,
      schedule: (fn, ms) => timers.push({ fn, ms }),
      sweep: () => {
        calls += 1
        if (calls < 3) throw new Error('database is locked')
        return 2
      },
    })
    expect(calls).toBe(1)
    timers.shift()!.fn()
    timers.shift()!.fn()
    expect(calls).toBe(3)
    expect(timers).toEqual([])

    let failing = 0
    sweepLeftoverBudgetHolds(db, {
      maxTries: 3,
      schedule: (fn) => fn(),
      sweep: () => {
        failing += 1
        throw new Error('database is locked')
      },
    })
    expect(failing).toBe(3)
  })
})
