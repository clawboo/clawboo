// The three things a person can do with a task that needs them: run it again,
// hand it to an agent, or dismiss it. Shared by the Needs you column and the task
// drawer so both say the same thing when an action works or is refused.
//
// Each resolves true when the action went through, so the caller can refresh.

import { useCallback } from 'react'

import { assignTask, retryTask, updateStatusResult } from '@/lib/boardClient'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'

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
        addToast({ type: 'success', message: 'Task dismissed.' })
        return true
      }
      addToast({ type: 'error', message: 'Couldn’t dismiss the task. Please try again.' })
      return false
    },
    [addToast],
  )

  return { retry, assign, dismiss }
}
