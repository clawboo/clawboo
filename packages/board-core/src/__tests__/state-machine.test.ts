// Rulebook invariants. The repository-level behaviour (updateStatus enforcing
// the machine inside a write transaction, completedAt stamping, the `→ todo`
// release) is covered by packages/db/src/board/__tests__/board.test.ts against a
// real SQLite file. What is tested HERE is the table itself: that the derived
// accessors agree with each other and that the table is internally well-formed.
//
// The PURITY guards (state-machine.ts declares no imports/re-exports; the built
// artifact carries zero bare specifiers) live in
// apps/web/src/__tests__/browserBundlePurity.test.ts, next to the consumer they
// protect. Keeping them out of this suite lets tsconfig.json exclude tests and
// pin `"types": []`, so a node global (`process`, `Buffer`) in the SOURCE is a
// typecheck failure — a guard no source-text scan provides.

import { describe, expect, it } from 'vitest'

import {
  TASK_STATUSES,
  canTransition,
  isLocked,
  isTaskStatus,
  isTerminal,
  legalTargets,
  type TaskStatus,
} from '../state-machine'

describe('the status universe', () => {
  it('has exactly the 7 canonical statuses, in lifecycle order, with no duplicates', () => {
    expect([...TASK_STATUSES]).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'blocked',
      'done',
      'cancelled',
    ])
    expect(new Set(TASK_STATUSES).size).toBe(TASK_STATUSES.length)
  })

  it('isTaskStatus accepts every canonical status and rejects everything else', () => {
    for (const s of TASK_STATUSES) expect(isTaskStatus(s)).toBe(true)
    for (const junk of ['', 'Done', 'in-progress', 'unknown', null, undefined, 7, {}, ['todo']]) {
      expect(isTaskStatus(junk)).toBe(false)
    }
  })
})

describe('legalTargets ↔ canTransition', () => {
  it('agree on every (from, to) pair', () => {
    const mismatches: string[] = []
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        // Same-status is an idempotent no-op that canTransition allows but
        // legalTargets deliberately omits, so it is excluded from the pairing.
        if (from === to) continue
        if (legalTargets(from).includes(to) !== canTransition(from, to)) {
          mismatches.push(`${from} → ${to}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('canTransition allows same-status for every status, legalTargets never lists it', () => {
    for (const s of TASK_STATUSES) {
      expect(canTransition(s, s)).toBe(true)
      expect(legalTargets(s)).not.toContain(s)
    }
  })
})

describe('the transition table is well-formed', () => {
  it('every legal target is itself a canonical status', () => {
    for (const from of TASK_STATUSES) {
      for (const to of legalTargets(from)) expect(TASK_STATUSES).toContain(to)
    }
  })

  it('lists no target twice for a given status', () => {
    for (const from of TASK_STATUSES) {
      const targets = legalTargets(from)
      expect(new Set(targets).size).toBe(targets.length)
    }
  })

  it('terminal ⇔ no outgoing transitions', () => {
    for (const s of TASK_STATUSES) {
      expect(isTerminal(s)).toBe(legalTargets(s).length === 0)
    }
    expect(TASK_STATUSES.filter(isTerminal)).toEqual(['done', 'cancelled'])
  })

  it('locked statuses are the actively-owned ones', () => {
    expect(TASK_STATUSES.filter(isLocked)).toEqual(['in_progress', 'in_review'])
  })

  it('every non-terminal status can reach cancelled (nothing is a dead end)', () => {
    for (const s of TASK_STATUSES) {
      if (isTerminal(s)) continue
      expect(legalTargets(s)).toContain<TaskStatus>('cancelled')
    }
  })
})

describe('legalTargets returns a defensive copy', () => {
  it('mutating the result does not corrupt the table for the next caller', () => {
    const first = legalTargets('todo')
    const snapshot = [...first]
    first.push('done')
    first.sort()
    expect(legalTargets('todo')).toEqual(snapshot)
    // And the mutation must not have leaked into the predicate either.
    expect(canTransition('todo', 'done')).toBe(false)
  })
})
