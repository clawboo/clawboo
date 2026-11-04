// Which of a verdict's open items (its `debtNotes`) the task drawer lists. A pass
// with debt lists all of them. A pass lists the ones nobody checked again, and a
// fail the ones it still carries, so the drawer shows what the API and agents
// read. Pure, so the cases are tested without a DOM.

import type { DebtNote } from '@clawboo/governance'

/**
 * The criterion of the item a failed verify command leaves, as the server writes
 * it (`GATE_DEBT_CRITERION` in @clawboo/governance, kept in step by a parity
 * test). A pass never lists it, and a fail only while the latest command fails.
 */
export const GATE_ITEM_CRITERION = 'deterministic gate'

interface VerdictCell {
  status?: string
  attempts?: {
    deterministic?: { passed?: boolean }
    critic?: { ran?: boolean; outcome?: string }
  }[]
  debtNotes?: DebtNote[]
}

/**
 * The open items to list under a verdict. A fail lists every one it carries, since
 * it has not shown any fixed, except the failed command's item when the latest
 * command passed. A pass lists them only when its own review did not complete:
 * the server clears them after a completed review, so any a reviewed pass still
 * holds were kept by an older Clawboo. A review recorded before outcomes existed
 * counts as completed, as the reviewer line reads it.
 */
export function openItemsOf(verdict: VerdictCell): DebtNote[] {
  const notes = verdict.debtNotes ?? []
  if (verdict.status === 'completed_with_debt') return notes
  const last = verdict.attempts?.[verdict.attempts.length - 1]
  const withoutGate = notes.filter((n) => n.criterion !== GATE_ITEM_CRITERION)
  if (verdict.status === 'fail') return last?.deterministic?.passed === false ? notes : withoutGate
  if (verdict.status !== 'pass') return []
  const critic = last?.critic
  const reviewed = critic?.ran === true && (critic.outcome ?? 'reviewed') === 'reviewed'
  return reviewed ? [] : withoutGate
}
