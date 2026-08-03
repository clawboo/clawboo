// Rulebook invariants + the purity guard that makes this module shareable.
//
// The repository-level behaviour (updateStatus enforcing the machine inside a
// write transaction, completedAt stamping, the `→ todo` release) is covered by
// packages/db/src/board/__tests__/board.test.ts against a real SQLite file. What
// is tested HERE is the table itself: that the derived accessors agree with each
// other, that the table is internally well-formed, and that the module stays
// import-free so it can ship into the browser bundle.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('purity: state-machine.ts is import-free so it can ship to the browser', () => {
  // Read the SOURCE, not the build output: a package's own `test` task only gets
  // turbo's `^build` (its DEPENDENCIES' builds), so dist/ may not exist here.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state-machine.ts'),
    'utf8',
  )
  // Strip line + block comments so prose mentioning "import" can't trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  it('declares no imports', () => {
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\bimport\s*\(/)
    expect(code).not.toMatch(/\brequire\s*\(/)
  })

  it('references no node builtin', () => {
    expect(code).not.toMatch(/['"]node:/)
  })
})
