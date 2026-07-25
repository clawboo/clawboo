// Parity guard: the board UI's boardStatus.ts hand-mirrors the server task state
// machine (packages/db/src/board/state-machine.ts) so it can offer only the moves
// the server accepts without dragging the db/sqlite graph into the browser bundle.
// This test imports BOTH and fails when they drift — a new status, a changed
// transition, or a terminal-state change on the server that the mirror missed.
//
// Node-project test (`*.test.ts`) so it can import @clawboo/db, exactly like the
// server suites do. NOTE: `@clawboo/db` resolves to its built `dist/`, so the guard
// compares against the LAST BUILD of the state machine. That's exactly what CI does
// — `turbo test` has the test task `dependsOn: ["^build"]`, so @clawboo/db is rebuilt
// first and drift is caught. A direct `vitest` run in apps/web without a prior
// `pnpm build` would compare against a possibly-stale dist; run via `pnpm test`
// (turbo) for the real guarantee.

import { describe, expect, it } from 'vitest'

import {
  TASK_STATUSES as DB_STATUSES,
  canTransition as dbCanTransition,
  isTerminal as dbIsTerminal,
} from '@clawboo/db'

import { TASK_STATUSES, isTerminalStatus, statusOptions } from '../boardStatus'

// The client's notion of "can I move from → to", derived from what the editor
// actually offers (statusOptions includes the current status + every legal target).
function clientCanTransition(from: string, to: string): boolean {
  if (from === to) return true // same-status is an idempotent no-op, like the server
  return (statusOptions(from) as string[]).includes(to)
}

describe('boardStatus ↔ @clawboo/db state-machine parity', () => {
  it('lists the same statuses in the same lifecycle order', () => {
    expect([...TASK_STATUSES]).toEqual([...DB_STATUSES])
  })

  it('permits exactly the same transitions for every (from, to) pair', () => {
    const mismatches: string[] = []
    for (const from of DB_STATUSES) {
      for (const to of DB_STATUSES) {
        if (clientCanTransition(from, to) !== dbCanTransition(from, to)) {
          mismatches.push(`${from} → ${to}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('agrees on which statuses are terminal', () => {
    for (const s of DB_STATUSES) {
      expect(isTerminalStatus(s)).toBe(dbIsTerminal(s))
    }
  })
})
