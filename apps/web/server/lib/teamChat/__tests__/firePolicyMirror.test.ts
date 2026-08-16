// The fire policy exists TWICE, on purpose, and nothing but a comment kept the
// two halves in agreement:
//
//   • `ledgerAllowsAutoFire` (@clawboo/team-orchestration) — the engine's own
//     decision when it pumps ready work;
//   • `isLedgerAutoFireable` (@clawboo/db) — the same decision, made by the
//     server's dispatch-pump SCAN, which runs without an engine resident.
//
// The duplication is deliberate: the engine package cannot import the db package
// (its board is host-injected, which is what lets the browser drive it). So the
// guard has to be a test, and it has to live somewhere that can see both — only
// apps/web depends on each of them.
//
// A drift here is not cosmetic. If the scan is more permissive than the engine,
// the pump re-fires work a user STOPPED; if it is stricter, delegated work sits
// forever after a restart with nobody to fire it.

import { describe, expect, it } from 'vitest'

import { isLedgerAutoFireable } from '@clawboo/db'
import {
  DELEGATION_IDLE_TIMEOUT_MS,
  ledgerAllowsAutoFire,
  MAX_AUTO_FIRES,
} from '@clawboo/team-orchestration'

const ledger = (...statuses: string[]): Array<{ status: string }> =>
  statuses.map((status) => ({ status }))

/** One table, both implementations. Each row states the intent, so a failure
 *  names the behaviour that drifted rather than just an index. */
const CASES: Array<{ why: string; execs: Array<{ status: string }>; fireable: boolean }> = [
  { why: 'never delivered (fresh / deferred / MCP-created)', execs: ledger(), fireable: true },
  { why: 'someone owns it right now', execs: ledger('running'), fireable: false },
  {
    why: 'a prior failure, then someone owns it',
    execs: ledger('failed', 'running'),
    fireable: false,
  },
  {
    why: 'user STOPPED it — a human re-queues deliberately',
    execs: ledger('cancelled'),
    fireable: false,
  },
  {
    why: 'user Stop after failures still wins',
    execs: ledger('failed', 'failed', 'cancelled'),
    fireable: false,
  },
  { why: 'infra death, not intent', execs: ledger('timed_out'), fireable: true },
  {
    why: 'two trailing failures is under the cap',
    execs: ledger('failed', 'timed_out'),
    fireable: true,
  },
  {
    why: 'trailing streak hits the cap — permafailing, park it',
    execs: ledger('failed', 'failed', 'timed_out'),
    fireable: false,
  },
  {
    why: 'a success resets the streak',
    execs: ledger('failed', 'failed', 'succeeded', 'failed'),
    fireable: true,
  },
  // Four rows, three of them failures, but only TWO of them trailing — so it is
  // still fireable. The cap counts the current streak, not the task's history.
  {
    why: 'streak counts only the TRAILING runs, not the total',
    execs: ledger('failed', 'succeeded', 'failed', 'failed'),
    fireable: true,
  },
  {
    why: 'three TRAILING failures after a success does hit the cap',
    execs: ledger('succeeded', 'failed', 'failed', 'failed'),
    fireable: false,
  },
  {
    why: 'a clean success is refireable (a plan step re-run)',
    execs: ledger('succeeded'),
    fireable: true,
  },
]

describe('fire policy — the engine and the server scan must agree', () => {
  it.each(CASES)('$why', ({ execs, fireable }) => {
    expect(ledgerAllowsAutoFire(execs)).toBe(fireable)
    expect(isLedgerAutoFireable(execs)).toBe(fireable)
  })

  it('both halves cap the trailing streak at the SAME number', () => {
    // Walk the boundary rather than trusting two constants that live in
    // different packages: the last fireable streak, then the first parked one.
    const under = ledger(...Array<string>(MAX_AUTO_FIRES - 1).fill('failed'))
    const at = ledger(...Array<string>(MAX_AUTO_FIRES).fill('failed'))
    expect(ledgerAllowsAutoFire(under)).toBe(true)
    expect(isLedgerAutoFireable(under)).toBe(true)
    expect(ledgerAllowsAutoFire(at)).toBe(false)
    expect(isLedgerAutoFireable(at)).toBe(false)
  })
})

// ─── Timer ordering the detach-on-release fix depends on ─────────────────────
// The sweep is what publishes `task_released`, and that release is what detaches
// a stale session from a resident engine. If the board's stale TTL were ever
// tuned above the engine's idle watchdog, the watchdog would reach the phantom
// session first, fail the task to `blocked`, and cancel its dependents — the
// permanent stall the detach exists to prevent. The two constants live in
// different packages, so nothing but this pins their relationship.
describe('sweep TTL vs the engine idle watchdog', () => {
  it('the stale-sweep default fires strictly BEFORE the idle watchdog', () => {
    const DEFAULT_STALE_TTL_MS = 3 * 60_000 // apps/web/server/index.ts
    expect(DEFAULT_STALE_TTL_MS).toBeLessThan(DELEGATION_IDLE_TIMEOUT_MS)
  })
})
