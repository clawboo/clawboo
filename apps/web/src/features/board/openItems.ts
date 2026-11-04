// Which of a verdict's open items (its `debtNotes`) the task drawer lists. A pass
// with debt lists all of them. A pass lists the ones nobody checked again, so the
// drawer shows what the API and agents read. Pure, so the cases are tested
// without a DOM.

import type { DebtNote } from '@clawboo/governance'

/**
 * The criterion of the item a failed verify command leaves, as the server writes
 * it (`GATE_DEBT_CRITERION` in @clawboo/governance, kept in step by a parity
 * test). A pass ran that command and it passed, so a pass never lists it.
 */
export const GATE_ITEM_CRITERION = 'deterministic gate'

interface VerdictCell {
  status?: string
  attempts?: { critic?: { ran?: boolean; outcome?: string } }[]
  debtNotes?: DebtNote[]
}

/**
 * The open items to list under a verdict. On a pass, only when its own review did
 * not complete: the server clears them after a completed review, so any a
 * reviewed pass still holds were kept by an older Clawboo. A review recorded
 * before outcomes existed counts as completed, as the reviewer line reads it.
 */
export function openItemsOf(verdict: VerdictCell): DebtNote[] {
  const notes = verdict.debtNotes ?? []
  if (verdict.status === 'completed_with_debt') return notes
  if (verdict.status !== 'pass') return []
  const critic = verdict.attempts?.[verdict.attempts.length - 1]?.critic
  const reviewed = critic?.ran === true && (critic.outcome ?? 'reviewed') === 'reviewed'
  return reviewed ? [] : notes.filter((n) => n.criterion !== GATE_ITEM_CRITERION)
}
