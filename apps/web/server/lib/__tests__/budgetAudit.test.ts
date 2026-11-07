// The audit rows for spend outside the task runner. What each kind of run writes
// is covered with that run; here, the rule they share.

import { createDb, listGovernanceAudit, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { auditBudgetCrossing } from '../budgetAudit'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const on = { scope: 'team', scopeId: 'T', runKind: 'chat', agentId: 'a1' } as const
const result = (crossed: 'none' | 'soft' | 'hard', mode: 'warn' | 'cap' = 'warn') => ({
  status: crossed === 'hard' && mode === 'cap' ? ('paused' as const) : ('soft_capped' as const),
  spentUsdCents: 85,
  limitUsdCents: 100,
  crossed,
  mode,
})

describe('auditBudgetCrossing', () => {
  it('writes nothing when no line was crossed, or the scope has no budget', () => {
    auditBudgetCrossing(db, { ...on, result: result('none') })
    auditBudgetCrossing(db, { ...on, result: null })
    expect(listGovernanceAudit(db, { eventType: 'budget' })).toEqual([])
  })

  it('writes the 80% and 100% warnings of a warn-only budget', () => {
    auditBudgetCrossing(db, { ...on, result: result('soft') })
    auditBudgetCrossing(db, { ...on, result: result('hard') })
    const summaries = listGovernanceAudit(db, { eventType: 'budget' }).map(
      (r) => JSON.parse(r.summary) as Record<string, unknown>,
    )
    expect(summaries.map((s) => [s['reason'], s['level'], s['pct']]).sort()).toEqual([
      ['warn', 'hard', 100],
      ['warn', 'soft', 80],
    ])
  })

  it('says a hard cap paused at 100%, and warns at its 80%', () => {
    auditBudgetCrossing(db, { ...on, result: result('soft', 'cap') })
    auditBudgetCrossing(db, { ...on, result: result('hard', 'cap') })
    const reasons = listGovernanceAudit(db, { eventType: 'budget' })
      .map((r) => (JSON.parse(r.summary) as Record<string, unknown>)['reason'])
      .sort()
    expect(reasons).toEqual(['auto_pause', 'warn'])
  })

  it('never throws: a run must not end because its audit row could not be written', () => {
    db.$client.close()
    expect(() => auditBudgetCrossing(db, { ...on, result: result('soft') })).not.toThrow()
  })
})
