// The one place a manual status change is committed, shared by the drawer's
// status editor (StatusSelect) and the board's drag-and-drop. Centralizing it
// guarantees both paths behave identically: they reject an illegal transition
// client-side (no wasted PATCH), ask before anything moves when the move needs a
// decision, update optimistically via caller-supplied callbacks, roll back on a
// server rejection, and toast a cause-specific message.
//
// What asks first:
//   · back to To do while an agent works on it: that run stops and starts over;
//   · Done or Cancelled (see finishMove): which day it finished when the card sits
//     on another day, and a confirmation when the move cannot be undone (Cancelled),
//     stops a running agent, or overrides a failed check.

import { useCallback } from 'react'

import { updateStatusResult, type BoardTask, type StatusChangeReason } from '@/lib/boardClient'
import { confirm } from '@/stores/confirm'
import { askFinish } from '@/stores/finishPrompt'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'

import { delegationTargetOf } from '@clawboo/board-core'

import { canTransition, statusLabel } from './boardStatus'
import { localeWeekStart } from './calendar/calendarModel'
import {
  createdAtOf,
  finishInstant,
  finishNeedFor,
  finishPromptNeeded,
  isFinishStatus,
  runningAgentId,
  runningSinceOf,
  sitsOnOtherDay,
} from './finishMove'

/** A refusal message that names the actual cause, so the user isn't left guessing. */
function statusErrorMessage(
  reason: StatusChangeReason | undefined,
  from: string,
  to: string,
): string {
  switch (reason) {
    case 'verification_required':
      return 'Verification hasn’t passed — this task can’t be completed.'
    case 'illegal_transition':
      return `Can’t move ${statusLabel(from)} → ${statusLabel(to)}.`
    case 'not_found':
      return 'This task no longer exists on the board.'
    case 'invalid_completed_at':
      return 'That day is outside the task’s life. Pick a day from when it was added to today.'
    default:
      return `Couldn’t move this task to ${statusLabel(to)}.`
  }
}

export interface StatusMutationInput {
  taskId: string
  from: string
  to: string
  /** The agent currently assigned; present ⇒ a `→ todo` move unassigns a live run. */
  assigneeAgentId?: string | null
  /** The task as the caller sees it, for the questions a finishing move asks (its
   *  title, its day, its check, whether a run is going). Without it, a finishing
   *  move asks only the cancel confirmation. */
  task?: BoardTask
  /** The board's clock, so the day choices match what it draws. Defaults to now. */
  now?: number
  /** First day of the week for the day picker. Defaults to the locale's. */
  weekStartsOn?: number
  /** The caller posts its own message for a success, so the hook doesn't. */
  quiet?: boolean
  /** Applied only after every question is answered, immediately before the
   *  write. `completedAt` is set for a move to Done or Cancelled. */
  applyOptimistic?: (completedAt?: number) => void
  /** Undo the optimistic change when the server rejects the move. */
  rollback?: () => void
}

/** What a committed move did. */
export interface StatusCommit {
  /** The finish time recorded for a move to Done or Cancelled. */
  completedAt?: number
  /** Plan steps that waited on a cancelled task and were cancelled with it. */
  cancelledDependents: Array<{ id: string; title: string }>
}

function agentName(agentId: string | null | undefined): string | null {
  if (!agentId) return null
  const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
  return agent?.name ?? 'The agent'
}

/** Returns a stable `mutate` fn; resolves what the move did, or null when it did
 *  not commit (refused, backed out, or rejected by the server). */
export function useStatusMutation(): (input: StatusMutationInput) => Promise<StatusCommit | null> {
  const addToast = useToastStore((s) => s.addToast)

  return useCallback(
    async ({
      taskId,
      from,
      to,
      assigneeAgentId,
      task,
      now: clock,
      weekStartsOn,
      quiet,
      applyOptimistic,
      rollback,
    }: StatusMutationInput) => {
      if (from === to) return null

      // Illegal transition → reject client-side; the drawer editor never offers one,
      // and a drag onto an illegal column shouldn't burn a doomed PATCH.
      if (!canTransition(from, to)) {
        addToast({
          type: 'error',
          message: `Can’t move ${statusLabel(from)} → ${statusLabel(to)}.`,
        })
        return null
      }

      const now = clock ?? Date.now()
      const running = task ? runningSinceOf(task) != null : false

      // Back to To do with an agent on it: it is unassigned, and a run in flight
      // stops. A task bound to an agent goes back in that agent's queue; one with no
      // agent bound waits in Needs you for a person to pick one.
      if (to === 'todo' && assigneeAgentId) {
        const name = agentName(assigneeAgentId) ?? 'The agent'
        const bound = task ? delegationTargetOf(task.sourceDelegationId as string | null) : true
        const after = bound
          ? 'It goes back in the queue and starts again from the beginning.'
          : 'No agent is set to pick it up again, so it waits in Needs you.'
        const proceed = await confirm({
          title: running ? `Stop ${name}’s run?` : 'Unassign the agent?',
          message: running
            ? `${name} is still working on it. Moving it to To do stops that run. ${after}`
            : `${name} is assigned to it and will be unassigned. ${after}`,
          confirmLabel: running ? 'Stop and move' : 'Move & unassign',
          tone: 'danger',
        })
        if (!proceed) return null
      }

      // Done or Cancelled: which day, and whether the person means it.
      let completedAt: number | undefined
      let override = false
      if (isFinishStatus(to)) {
        const need = task
          ? finishNeedFor(task, to, now)
          : { to, otherDay: false, running: false, failedCheck: false }
        if (finishPromptNeeded(need)) {
          const createdAt = task ? createdAtOf(task) : null
          const choice = await askFinish({
            to,
            title: typeof task?.title === 'string' ? task.title : '',
            sitsOn: task ? sitsOnOtherDay(task, now) : null,
            createdAt,
            runningAgent: task ? agentName(runningAgentId(task)) : null,
            failedCheck: need.failedCheck,
            now,
            weekStartsOn: weekStartsOn ?? localeWeekStart(),
          })
          if (!choice) return null
          completedAt = finishInstant(choice.day, createdAt, now)
          override = need.failedCheck
        } else {
          completedAt = now
        }
      }

      applyOptimistic?.(completedAt)
      let res = await updateStatusResult(taskId, to, {
        ...(override ? { humanOverride: true } : {}),
        ...(completedAt !== undefined && completedAt !== now ? { completedAt } : {}),
      })

      // The verification gate refused a manual → done that the client did not see
      // coming (the verdict changed since the board last read it). Not a dead-end:
      // offer the server's audited human override instead of just rolling back.
      if (!res.ok && res.reason === 'verification_required' && to === 'done') {
        const proceed = await confirm({
          title: 'Complete anyway?',
          message:
            'This task hasn’t passed verification. Completing it is a manual override and will be recorded in the audit log.',
          confirmLabel: 'Complete anyway',
          tone: 'danger',
        })
        if (!proceed) {
          rollback?.() // a deliberate decline — roll back quietly, no error toast
          return null
        }
        res = await updateStatusResult(taskId, to, {
          humanOverride: true,
          ...(completedAt !== undefined && completedAt !== now ? { completedAt } : {}),
        })
      }

      if (res.ok) {
        if (!quiet) addToast({ type: 'success', message: `Status updated to ${statusLabel(to)}` })
        return {
          ...(completedAt !== undefined ? { completedAt } : {}),
          cancelledDependents: res.cancelledDependents ?? [],
        }
      }
      rollback?.()
      addToast({ type: 'error', message: statusErrorMessage(res.reason, from, to) })
      return null
    },
    [addToast],
  )
}
