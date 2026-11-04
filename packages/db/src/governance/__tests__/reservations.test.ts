import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { budgetReservations } from '../../schema'
import { getBudget, recordSpend, setBudgetLimit } from '../budgets'
import {
  admitAgainstBudget,
  heldByBudget,
  releaseBudgetHold,
  reserveBudgets,
  sweepForeignBudgetReservations,
} from '../reservations'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-reserve-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const agentScope = [{ scope: 'agent' as const, scopeId: 'a1' }]

function holdRows(holdId: string) {
  return db.select().from(budgetReservations).where(eq(budgetReservations.holdId, holdId)).all()
}

function heldCents(scope: 'agent' | 'team' | 'mission', scopeId: string): number {
  const b = getBudget(db, scope, scopeId)
  if (!b) return 0
  return (heldByBudget(db).get(b.id)?.heldMicroCents ?? 0) / 10_000
}

describe('admitAgainstBudget (the rule)', () => {
  const base = {
    mode: 'cap' as const,
    status: 'active',
    limitMicroCents: 100_0000,
    spentMicroCents: 95_0000,
    otherRuns: 0,
    otherHeldMicroCents: 0,
    estimateMicroCents: 10_0000,
  }

  it('lets a run with no other run going start while the cap is not paused', () => {
    expect(admitAgainstBudget(base)).toBeNull()
  })

  it('refuses any run on a paused cap', () => {
    expect(admitAgainstBudget({ ...base, status: 'paused' })).toBe('paused')
  })

  it('lets a parallel run start only when its estimate fits beside the others', () => {
    expect(admitAgainstBudget({ ...base, otherRuns: 1, otherHeldMicroCents: 10_0000 })).toBe('held')
    expect(
      admitAgainstBudget({
        ...base,
        spentMicroCents: 50_0000,
        otherRuns: 1,
        otherHeldMicroCents: 10_0000,
      }),
    ).toBeNull()
  })

  it('counts a run going as parallel even once its hold is used up', () => {
    expect(admitAgainstBudget({ ...base, otherRuns: 1, otherHeldMicroCents: 0 })).toBe('held')
  })

  it('never refuses on a warn-only budget', () => {
    expect(admitAgainstBudget({ ...base, mode: 'warn', status: 'paused' })).toBeNull()
    expect(admitAgainstBudget({ ...base, mode: 'warn', otherRuns: 3 })).toBeNull()
  })
})

describe('reserveBudgets', () => {
  it('holds nothing for a scope with no budget', () => {
    const r = reserveBudgets(db, { scopes: agentScope, estimateCents: 50, runKind: 'task' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(holdRows(r.holdId)).toHaveLength(0)
  })

  it('two runs against a nearly spent hard cap: only the first is let start', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 95)

    const first = reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' })
    const second = reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' })

    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, scope: 'agent', reason: 'held' })
    expect(heldCents('agent', 'a1')).toBe(10)
  })

  it('lets parallel runs start while their estimates fit under the cap', () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 100, mode: 'cap' })
    const scopes = [{ scope: 'team' as const, scopeId: 't1' }]
    const runs = [1, 2, 3, 4].map(() =>
      reserveBudgets(db, { scopes, estimateCents: 30, runKind: 'team-chat' }),
    )
    // 30 + 30 + 30 = 90 fits; a fourth would make 120.
    expect(runs.map((r) => r.ok)).toEqual([true, true, true, false])
  })

  it('refuses a paused cap and says so', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 100)
    expect(reserveBudgets(db, { scopes: agentScope, estimateCents: 1, runKind: 'chat' })).toEqual({
      ok: false,
      scope: 'agent',
      reason: 'paused',
    })
  })

  it('a warn-only budget never refuses but still records the hold', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'warn' })
    recordSpend(db, 'agent', 'a1', 150)
    const a = reserveBudgets(db, { scopes: agentScope, estimateCents: 40, runKind: 'task' })
    const b = reserveBudgets(db, { scopes: agentScope, estimateCents: 40, runKind: 'task' })
    expect(a.ok && b.ok).toBe(true)
    expect(heldCents('agent', 'a1')).toBe(80)
  })

  it('a refusal on one scope writes no hold on the others', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1000, mode: 'cap' })
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 't1', 100)
    const r = reserveBudgets(db, {
      scopes: [
        { scope: 'agent', scopeId: 'a1' },
        { scope: 'team', scopeId: 't1' },
      ],
      estimateCents: 10,
      runKind: 'task',
    })
    expect(r).toEqual({ ok: false, scope: 'team', reason: 'paused' })
    expect(heldByBudget(db).size).toBe(0)
  })

  it('reserving again with the same hold is the final gate: its own hold does not count', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 95)
    const first = reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' })
    if (!first.ok) throw new Error('first run refused')
    const again = reserveBudgets(db, {
      holdId: first.holdId,
      scopes: agentScope,
      estimateCents: 10,
      runKind: 'task',
    })
    expect(again).toEqual({ ok: true, holdId: first.holdId })
    // Still one row: the recheck adds nothing for a budget the hold already has.
    expect(holdRows(first.holdId)).toHaveLength(1)
  })

  it('the final gate refuses a run whose cap paused while it got ready', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    const mine = reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' })
    if (!mine.ok) throw new Error('refused')
    // Another run's spend pauses the cap meanwhile.
    recordSpend(db, 'agent', 'a1', 120)
    expect(
      reserveBudgets(db, {
        holdId: mine.holdId,
        scopes: agentScope,
        estimateCents: 10,
        runKind: 'task',
      }),
    ).toEqual({ ok: false, scope: 'agent', reason: 'paused' })
  })

  it('the final gate holds a budget created after the run was let start', () => {
    const mine = reserveBudgets(db, {
      scopes: [{ scope: 'team', scopeId: 't1' }],
      estimateCents: 10,
      runKind: 'team-chat',
    })
    if (!mine.ok) throw new Error('refused')
    setBudgetLimit(db, { scope: 'team', scopeId: 't1', limitUsdCents: 100, mode: 'cap' })
    reserveBudgets(db, {
      holdId: mine.holdId,
      scopes: [{ scope: 'team', scopeId: 't1' }],
      estimateCents: 10,
      runKind: 'team-chat',
    })
    expect(holdRows(mine.holdId)).toHaveLength(1)
  })

  it('reads the holds of another connection under the write lock', async () => {
    // Another server process (its own connection, on its own thread) lets a run
    // start against the same nearly spent cap and keeps the write lock for a while
    // before committing. A run asking meanwhile must wait for it and see its hold.
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 95)
    const budgetId = getBudget(db, 'agent', 'a1')!.id
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads')
      const Database = require(workerData.driver)
      const conn = new Database(workerData.file)
      conn.pragma('busy_timeout = 5000')
      conn.exec('BEGIN IMMEDIATE')
      conn.prepare(
        "INSERT INTO budget_reservations (id, hold_id, budget_id, held_micro_cents, estimate_micro_cents, run_kind, created_at, updated_at) VALUES ('r-other', 'h-other', ?, 100000, 100000, 'task', 1, 1)",
      ).run(workerData.budgetId)
      parentPort.postMessage('locked')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs)
      conn.exec('COMMIT')
      conn.close()
      `,
      {
        eval: true,
        workerData: {
          // __filename is provided by vitest for this CommonJS package.
          driver: createRequire(__filename).resolve('better-sqlite3'),
          file: path.join(dir, 'test.db'),
          budgetId,
          holdMs: 400,
        },
      },
    )
    const exited = once(worker, 'exit')
    await once(worker, 'message')

    const mine = reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' })
    await exited

    expect(mine).toEqual({ ok: false, scope: 'agent', reason: 'held' })
  })
})

describe('recordSpend against a hold, and the end of a run', () => {
  it('shrinks the hold by the spend, never below zero', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1000, mode: 'cap' })
    const r = reserveBudgets(db, { scopes: agentScope, estimateCents: 50, runKind: 'task' })
    if (!r.ok) throw new Error('refused')
    recordSpend(db, 'agent', 'a1', 20, { holdId: r.holdId })
    expect(heldCents('agent', 'a1')).toBe(30)
    recordSpend(db, 'agent', 'a1', 45, { holdId: r.holdId })
    expect(heldCents('agent', 'a1')).toBe(0)
    expect(getBudget(db, 'agent', 'a1')?.spentUsdCents).toBe(65)
  })

  it('settling replaces the estimate with what the run spent', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 40)
    const r = reserveBudgets(db, { scopes: agentScope, estimateCents: 50, runKind: 'task' })
    if (!r.ok) throw new Error('refused')
    // While it runs, the budget has committed its spend plus the estimate.
    expect(getBudget(db, 'agent', 'a1')!.spentUsdCents + heldCents('agent', 'a1')).toBe(90)
    // It ends having spent 12; the hold goes and only the real spend is left.
    recordSpend(db, 'agent', 'a1', 12, { holdId: r.holdId })
    expect(releaseBudgetHold(db, r.holdId)).toBe(1)
    expect(heldCents('agent', 'a1')).toBe(0)
    expect(getBudget(db, 'agent', 'a1')?.spentUsdCents).toBe(52)
    // With the hold gone, a second run that would not have fit beside it starts.
    expect(reserveBudgets(db, { scopes: agentScope, estimateCents: 50, runKind: 'task' }).ok).toBe(
      true,
    )
  })

  it('a released hold lets the next parallel run start; releasing twice is harmless', () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'a1', 95)
    const first = reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' })
    if (!first.ok) throw new Error('refused')
    expect(reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' }).ok).toBe(
      false,
    )
    releaseBudgetHold(db, first.holdId)
    expect(releaseBudgetHold(db, first.holdId)).toBe(0)
    expect(reserveBudgets(db, { scopes: agentScope, estimateCents: 10, runKind: 'task' }).ok).toBe(
      true,
    )
  })
})

describe('sweepForeignBudgetReservations (the start-up sweep)', () => {
  const me = { pid: 4242, startedAt: 1_000 }
  const take = (owner: { pid: number; startedAt: number } | null, createdAt = 10_000_000) => {
    const r = reserveBudgets(db, {
      scopes: agentScope,
      estimateCents: 5,
      runKind: 'task',
      owner,
      now: createdAt,
    })
    if (!r.ok) throw new Error('refused')
    return r.holdId
  }

  beforeEach(() => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1000, mode: 'cap' })
  })

  it('drops every hold this server did not take, and keeps its own however old', () => {
    const mine = take(me, 1)
    const earlierRun = take({ pid: 4343, startedAt: 2_000 })
    // The same pid as this server, a different process: an earlier server that held it.
    const samePid = take({ pid: me.pid, startedAt: 500 })
    const unowned = take(null)

    expect(sweepForeignBudgetReservations(db, me)).toBe(3)
    expect(holdRows(mine)).toHaveLength(1)
    for (const gone of [earlierRun, samePid, unowned]) expect(holdRows(gone)).toHaveLength(0)
  })

  it('removes a large backlog in one statement', () => {
    // One hold on each of 40,000 budgets: more ids than SQLite binds in one list.
    const insert = db.$client.prepare(
      "INSERT INTO budget_reservations (id, hold_id, budget_id, held_micro_cents, estimate_micro_cents, run_kind, owner_pid, owner_started_at, created_at, updated_at) VALUES (?, 'h-old', ?, 1, 1, 'task', 1, 1, 1, 1)",
    )
    const budgetId = getBudget(db, 'agent', 'a1')!.id
    db.$client.exec('DROP INDEX uniq_budget_reservations_hold')
    db.$client.transaction(() => {
      for (let i = 0; i < 40_000; i++) insert.run(`r-${i}`, budgetId)
    })()
    expect(sweepForeignBudgetReservations(db, me)).toBe(40_000)
    expect(heldByBudget(db).size).toBe(0)
  })

  it('is safe to run again once this server holds runs', () => {
    take({ pid: 4343, startedAt: 2_000 })
    expect(sweepForeignBudgetReservations(db, me)).toBe(1)
    const mine = take(me)
    expect(sweepForeignBudgetReservations(db, me)).toBe(0)
    expect(holdRows(mine)).toHaveLength(1)
  })
})
