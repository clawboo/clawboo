// The one place a manual status change is committed, shared by the drawer's
// status editor (StatusSelect) and the board's drag-and-drop. Centralizing it
// guarantees both paths behave identically: they reject an illegal transition
// client-side (no wasted PATCH), confirm before the agent-release (`→ todo`)
// move, update optimistically via caller-supplied callbacks, roll back on a
// server rejection, and toast either way.

import { useCallback } from 'react'

import { boardClient } from '@/lib/boardClient'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'

import { canTransition, statusLabel } from './boardStatus'

export interface StatusMutationInput {
  taskId: string
  from: string
  to: string
  /** The agent currently assigned; present ⇒ a `→ todo` move unassigns a live run. */
  assigneeAgentId?: string | null
  /** Applied only after the confirm gate passes, immediately before the write. */
  applyOptimistic?: () => void
  /** Undo the optimistic change when the server rejects the move. */
  rollback?: () => void
}

/** Returns a stable `mutate` fn; resolves `true` when the status change committed. */
export function useStatusMutation(): (input: StatusMutationInput) => Promise<boolean> {
  const addToast = useToastStore((s) => s.addToast)

  return useCallback(
    async ({
      taskId,
      from,
      to,
      assigneeAgentId,
      applyOptimistic,
      rollback,
    }: StatusMutationInput) => {
      if (from === to) return false

      // Illegal transition → reject client-side; the drawer editor never offers one,
      // and a drag onto an illegal column shouldn't burn a doomed PATCH.
      if (!canTransition(from, to)) {
        addToast({
          type: 'error',
          message: `Can’t move ${statusLabel(from)} → ${statusLabel(to)}.`,
        })
        return false
      }

      // Agent-release guard: any `→ todo` clears the assignee server-side, pulling an
      // actively-worked task out from under its agent. Confirm before doing so.
      if (to === 'todo' && assigneeAgentId) {
        const proceed = await confirm({
          title: 'Unassign the agent?',
          message:
            'Moving this task back to “To do” releases it for re-claim — the agent assigned to it will be unassigned.',
          confirmLabel: 'Move & unassign',
          tone: 'danger',
        })
        if (!proceed) return false
      }

      applyOptimistic?.()
      const ok = await boardClient.updateStatus(taskId, to)
      if (ok) {
        addToast({ type: 'success', message: `Status updated to ${statusLabel(to)}` })
      } else {
        rollback?.()
        addToast({ type: 'error', message: `Couldn’t move this task to ${statusLabel(to)}.` })
      }
      return ok
    },
    [addToast],
  )
}
