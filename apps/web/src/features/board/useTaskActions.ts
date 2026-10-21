// The three things a person can do with a task that needs them: run it again,
// hand it to an agent, or dismiss it. Shared by the Needs you column and the task
// drawer so both say the same thing when an action works or is refused.
//
// Each resolves true when the action went through, so the caller can refresh.
// The batch versions (one card standing for several tasks with the same cause)
// ask once, say one thing at the end, and resolve to how many went through.

import { useCallback } from 'react'

import { assignTask, retryTask, updateStatusResult } from '@/lib/boardClient'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'

import { countLabel } from './calendar/calendarFormat'

const NUMBER_WORDS = 'Zero One Two Three Four Five Six Seven Eight Nine'.split(' ')

/** "One was refused." / "Two were refused." / "12 were refused." */
function refusedSentence(n: number): string {
  const word = NUMBER_WORDS[n] ?? String(n)
  return `${word} ${n === 1 ? 'was' : 'were'} refused.`
}

/** Runs `run` for every id at once and counts the ones that went through. */
async function countSucceeded(
  ids: readonly string[],
  run: (id: string) => Promise<{ ok: boolean }>,
): Promise<number> {
  const results = await Promise.allSettled(ids.map((id) => run(id)))
  return results.filter((r) => r.status === 'fulfilled' && r.value.ok).length
}

const RETRY_REFUSED: Record<string, string> = {
  unassigned: 'Assign an agent to this task first.',
  not_retryable: 'This task is already running or finished.',
  no_team: 'This task has no team, so no agent can run it.',
}

const ASSIGN_REFUSED: Record<string, string> = {
  agent_not_in_team: 'That agent is not on this task’s team.',
  not_assignable: 'This task is already being worked on or is finished.',
  no_team: 'This task has no team, so no agent can run it.',
}

export interface TaskActions {
  retry: (taskId: string) => Promise<boolean>
  assign: (taskId: string, agentId: string, agentName: string) => Promise<boolean>
  dismiss: (taskId: string) => Promise<boolean>
  /** Retry every task at once, with one summary toast. Resolves to how many
   *  went back to their agents. */
  retryMany: (taskIds: readonly string[]) => Promise<number>
  /** Dismiss every task after one confirm naming the count, with one summary
   *  toast. Resolves to how many moved to Cancelled (0 when the person backs out). */
  dismissMany: (taskIds: readonly string[]) => Promise<number>
}

export function useTaskActions(): TaskActions {
  const addToast = useToastStore((s) => s.addToast)

  const retry = useCallback(
    async (taskId: string) => {
      const res = await retryTask(taskId)
      if (res.ok) {
        addToast({ type: 'success', message: 'Retrying. The task is back with its agent.' })
        return true
      }
      addToast({
        type: 'error',
        message: RETRY_REFUSED[res.reason] ?? 'Couldn’t retry the task. Please try again.',
      })
      return false
    },
    [addToast],
  )

  const assign = useCallback(
    async (taskId: string, agentId: string, agentName: string) => {
      const res = await assignTask(taskId, agentId)
      if (res.ok) {
        addToast({ type: 'success', message: `Assigned to ${agentName}. It starts now.` })
        return true
      }
      addToast({
        type: 'error',
        message: ASSIGN_REFUSED[res.reason] ?? 'Couldn’t assign the task. Please try again.',
      })
      return false
    },
    [addToast],
  )

  const dismiss = useCallback(
    async (taskId: string) => {
      const proceed = await confirm({
        title: 'Dismiss this task?',
        message: 'It moves to Cancelled and will not run again.',
        confirmLabel: 'Dismiss',
        tone: 'danger',
      })
      if (!proceed) return false
      const res = await updateStatusResult(taskId, 'cancelled')
      if (res.ok) {
        // A cancelled task takes the plan steps that waited on it with it.
        const n = res.cancelledDependents?.length ?? 0
        const chain =
          n > 0
            ? ` ${n === 1 ? 'One later step' : `${n} later steps`} waiting on it ${n === 1 ? 'was' : 'were'} cancelled too.`
            : ''
        addToast({ type: 'success', message: `Task dismissed.${chain}` })
        return true
      }
      addToast({ type: 'error', message: 'Couldn’t dismiss the task. Please try again.' })
      return false
    },
    [addToast],
  )

  const retryMany = useCallback(
    async (taskIds: readonly string[]) => {
      const n = taskIds.length
      if (n === 0) return 0
      const ok = await countSucceeded(taskIds, retryTask)
      if (ok === n) {
        addToast({ type: 'success', message: `Retrying ${countLabel(n, 'task')}.` })
      } else if (ok > 0) {
        addToast({ type: 'info', message: `Retried ${ok} of ${n}. ${refusedSentence(n - ok)}` })
      } else {
        addToast({
          type: 'error',
          message: `Couldn’t retry ${n === 1 ? 'the task' : 'the tasks'}. Please try again.`,
        })
      }
      return ok
    },
    [addToast],
  )

  const dismissMany = useCallback(
    async (taskIds: readonly string[]) => {
      const n = taskIds.length
      if (n === 0) return 0
      const proceed = await confirm({
        title: `Dismiss ${countLabel(n, 'task')}?`,
        message: `${n === 1 ? 'It moves' : 'They move'} to Cancelled and will not run again.`,
        confirmLabel: n === 1 ? 'Dismiss' : 'Dismiss all',
        tone: 'danger',
      })
      if (!proceed) return 0
      const ok = await countSucceeded(taskIds, (id) => updateStatusResult(id, 'cancelled'))
      if (ok === n) {
        addToast({ type: 'success', message: `Dismissed ${countLabel(n, 'task')}.` })
      } else if (ok > 0) {
        addToast({ type: 'info', message: `Dismissed ${ok} of ${n}. ${refusedSentence(n - ok)}` })
      } else {
        addToast({
          type: 'error',
          message: `Couldn’t dismiss ${n === 1 ? 'the task' : 'the tasks'}. Please try again.`,
        })
      }
      return ok
    },
    [addToast],
  )

  return { retry, assign, dismiss, retryMany, dismissMany }
}
