// Drift guard for the board UI's status metadata.
//
// The status list and the transition table are no longer mirrored here — the UI
// derives both from @clawboo/board-core (see ../boardStatus). So what this file
// guards is (a) the part that is STILL hand-written, the STATUS_LABEL map, and
// (b) the derivation itself: the ordering, the off-list degradation, and the
// string-tolerant wrappers, each of which a UI surface depends on.
//
// Node-project test (`*.test.ts`). @clawboo/board-core is a pure zero-dep package,
// so importing it here costs nothing; @clawboo/db is imported TYPE-ONLY (erased at
// build) for the union backstop below.

import { describe, expect, it } from 'vitest'

import {
  TASK_STATUSES,
  canTransition as coreCanTransition,
  isTerminal as coreIsTerminal,
  legalTargets,
  type TaskStatus as CoreTaskStatus,
} from '@clawboo/board-core'
import type { TaskStatus as DbTaskStatus } from '@clawboo/db'

import {
  STATUS_LABEL,
  canTransition,
  isTerminalStatus,
  statusLabel,
  statusOptions,
} from '../boardStatus'

const OFF_LIST = ['', 'bogus', 'Done', 'in-progress', 'unknown']

describe('STATUS_LABEL covers exactly the canonical statuses', () => {
  it('labels every status — a new server status can never render unlabelled', () => {
    for (const s of TASK_STATUSES) {
      expect(STATUS_LABEL[s]).toBeTruthy()
    }
  })

  it('carries no label for a status that no longer exists', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual([...TASK_STATUSES].sort())
  })
})

describe('statusOptions derives from the shared rulebook', () => {
  it('offers the current status plus every legal target, in canonical order', () => {
    for (const from of TASK_STATUSES) {
      const expected = TASK_STATUSES.filter((s) => s === from || legalTargets(from).includes(s))
      expect(statusOptions(from)).toEqual(expected)
    }
  })

  it('orders by lifecycle, not by transition-table order (the dropdown reads as the columns)', () => {
    // Guards the assertion above from being vacuous: for `todo` the two orders
    // genuinely differ, so a switch to `[from, ...legalTargets(from)]` would fail.
    expect(statusOptions('todo')).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'blocked',
      'cancelled',
    ])
    expect(['todo', ...legalTargets('todo')]).not.toEqual(statusOptions('todo'))
  })

  it('yields an empty list for an off-list status, so the editor locks read-only', () => {
    // StatusSelect keys its read-only fallback off `options.length === 0`, and
    // BoardPanel keys `cardDisabled` off `length <= 1` — returning `[from]` here
    // would silently re-enable both.
    for (const s of OFF_LIST) expect(statusOptions(s)).toEqual([])
  })

  it('offers nothing but itself for a terminal status', () => {
    expect(statusOptions('done')).toEqual(['done'])
    expect(statusOptions('cancelled')).toEqual(['cancelled'])
  })
})

describe('the string-tolerant wrappers agree with the rulebook', () => {
  it('permits exactly the same transitions for every (from, to) pair', () => {
    const mismatches: string[] = []
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (canTransition(from, to) !== coreCanTransition(from, to)) {
          mismatches.push(`${from} → ${to}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('refuses every off-list status — including same-status, which is NOT a no-op here', () => {
    for (const s of OFF_LIST) {
      expect(canTransition(s, s)).toBe(false)
      expect(canTransition(s, 'todo')).toBe(false)
      expect(canTransition('todo', s)).toBe(false)
    }
  })

  it('agrees on which statuses are terminal', () => {
    for (const s of TASK_STATUSES) expect(isTerminalStatus(s)).toBe(coreIsTerminal(s))
    for (const s of OFF_LIST) expect(isTerminalStatus(s)).toBe(false)
  })

  it('falls back to the raw string when labelling an off-list status', () => {
    for (const s of OFF_LIST) expect(statusLabel(s)).toBe(s)
    expect(statusLabel('in_review')).toBe('In review')
  })
})

// Backstop: @clawboo/db re-exports board-core's machine rather than declaring its
// own. If someone reintroduces a local union there, these collapse to `false` and
// `pnpm typecheck` fails (apps/web's tsconfig includes src/**/*).
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('@clawboo/db still re-exports the shared union', () => {
  it('has a TaskStatus identical to @clawboo/board-core’s', () => {
    const same: MutuallyAssignable<DbTaskStatus, CoreTaskStatus> = true
    expect(same).toBe(true)
  })
})
