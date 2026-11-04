// `GATE_ITEM_CRITERION` has to match the criterion the server writes, or a pass
// stored by an older Clawboo lists the failed command's item under "Passed".

import { describe, expect, it } from 'vitest'

import { GATE_DEBT_CRITERION } from '@clawboo/governance'

import { GATE_ITEM_CRITERION, openItemsOf } from '../openItems'

describe('openItemsOf', () => {
  const token = {
    criterion: 'Token logged in plain text',
    severity: 'security' as const,
    justification: 'unresolved at cycle exhaustion',
  }
  const gate = {
    criterion: GATE_DEBT_CRITERION,
    severity: 'crash' as const,
    justification: 'The deterministic gate failed: `exit 1` exited 1.',
  }

  it('names the failed command item as the server does', () => {
    expect(GATE_ITEM_CRITERION).toBe(GATE_DEBT_CRITERION)
    const pass = { status: 'pass', attempts: [{ critic: { ran: false } }], debtNotes: [gate] }
    expect(openItemsOf(pass)).toEqual([])
  })

  it("lists a failed check's items, with the command's only while it still fails", () => {
    const fail = (passed: boolean) => ({
      status: 'fail',
      attempts: [{ deterministic: { passed } }],
      debtNotes: [token, gate],
    })
    expect(openItemsOf(fail(false))).toEqual([token, gate])
    expect(openItemsOf(fail(true))).toEqual([token])
  })
})
