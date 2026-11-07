// The three things a person can do with a task that needs them: run it again,
// hand it to an agent, or dismiss it. Shared by the Needs you column and the task
// drawer so both say the same thing when an action works or is refused.
//
// Each resolves true when the action went through, so the caller can refresh.
// The batch versions (one card standing for several tasks with the same cause)
// ask once, say one thing at the end, and resolve to how many went through.

import { useCallback } from 'react'

import {
  assignTask,
  assignTaskToPerson,
  reopenTask,
  retryTask,
  updateStatusResult,
} from '@/lib/boardClient'
import { confirm } from '@/stores/confirm'
import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useToastStore } from '@/stores/toast'

import { notDeliveredWhy, type TaskAttention } from './boardStatus'
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
  return (await settleAll(ids, run)).ok
}

/** Runs `run` for every id at once: how many went through, and the reasons the
 *  rest were refused (null for a request that failed without one). */
async function settleAll<R extends { ok: boolean; reason?: string }>(
  ids: readonly string[],
  run: (id: string) => Promise<R>,
): Promise<{ ok: number; reasons: Array<string | null> }> {
  const results = await Promise.allSettled(ids.map((id) => run(id)))
  const reasons: Array<string | null> = []
  let ok = 0
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) ok += 1
    else reasons.push(r.status === 'fulfilled' ? (r.value.reason ?? null) : null)
  }
  return { ok, reasons }
}

/** A task still filed under an archived chat room: nothing can run it there, and
 *  the pass that moves such tasks to General runs when Clawboo starts. */
const ROOM_ARCHIVED =
  'This task’s chat room was archived, so nothing can run it there. Restart Clawboo to move it to General, then try again.'
const ROOMS_ARCHIVED =
  'These tasks’ chat rooms were archived, so nothing can run them there. Restart Clawboo to move them to General, then try again.'

const RETRY_REFUSED: Record<string, string> = {
  main_task: 'This is your request, which runs nothing itself. Retry its sub-tasks.',
  unassigned: 'Assign an agent to this task first.',
  not_retryable: 'This task is already running or finished.',
  no_team: 'This task has no team, so no agent can run it.',
  room_archived: ROOM_ARCHIVED,
  paused: 'This task is paused. Resume it first, and it starts by itself.',
}

const REOPEN_REFUSED: Record<string, string> = {
  not_finished: 'This task is not finished, so there is nothing to reopen.',
  blocker_cancelled:
    'A task this one depends on was cancelled, so nothing would start it. Reopen that task first.',
}

const ASSIGN_REFUSED: Record<string, string> = {
  agent_not_in_team: 'That agent is not on this task’s team.',
  not_assignable: 'This task is already being worked on or is finished.',
  no_team: 'This task has no team, so no agent can run it.',
  room_archived: ROOM_ARCHIVED,
}

/** Say why a write was refused. The person check has its own notice, said once however
 *  many cards were tried, and trying again would not change it. */
function sayRefused(reason: string, refused: Record<string, string>, otherwise: string): void {
  if (reason === 'person_only') notePersonCheck(PERSON_CHECK_REFUSED)
  else useToastStore.getState().addToast({ type: 'error', message: refused[reason] ?? otherwise })
}

/** What has to be fixed before an account refusal can run, as the confirm says it. */
const ACCOUNT_FIX: Record<NonNullable<TaskAttention['cause']>, string> = {
  sign_in: 'the sign-in',
  billing: 'the billing',
}

/**
 * Before retrying a run the provider refused for the account: say why it failed
 * and that it will fail the same way. Resolves true to go ahead. Any other
 * failure retries without asking.
 */
async function confirmAccountRetry(attention: TaskAttention | undefined, n = 1): Promise<boolean> {
  if (!attention?.cause) return true
  const fix = ACCOUNT_FIX[attention.cause]
  return confirm({
    title: `Retry before fixing ${fix}?`,
    message: `${attention.detail ? `${n === 1 ? 'The last run' : 'Each last run'} failed: ${attention.detail.replace(/\.$/, '')}. ` : ''}${n === 1 ? 'It fails' : 'They fail'} the same way until ${fix} is fixed.`,
    confirmLabel: 'Retry anyway',
  })
}

export interface TaskActions {
  /** Hand the task back to its agent. For a run the provider refused for the
   *  account, asks first (`attention` is the card's needs-you state). */
  retry: (taskId: string, attention?: TaskAttention) => Promise<boolean>
  assign: (taskId: string, agentId: string, agentName: string) => Promise<boolean>
  dismiss: (taskId: string) => Promise<boolean>
  /** Retry every task at once, with one summary toast. Resolves to how many
   *  went back to their agents. Asks first, like `retry`, for an account refusal. */
  retryMany: (taskIds: readonly string[], attention?: TaskAttention) => Promise<number>
  /** Open Settings at the runtime whose sign-in or billing a run was refused for. */
  fixSignIn: (runtime?: string) => void
  /** Dismiss every task after one confirm naming the count, with one summary
   *  toast. Resolves to how many moved to Cancelled (0 when the person backs out). */
  dismissMany: (taskIds: readonly string[]) => Promise<number>
  /** Give the task to the person using the board. */
  assignToMe: (taskId: string) => Promise<boolean>
  /** Give the task to the person who asked for it. */
  assignToPerson: (taskId: string, personId: string, name: string) => Promise<boolean>
  /** A person's own task is finished. */
  markDone: (taskId: string) => Promise<boolean>
  /** Reopen a finished task, with an optional note for its agent. `onThread`: the note
   *  is a reply already saved on the task. */
  reopen: (
    taskId: string,
    comment?: string,
    opts?: { onThread?: boolean; request?: boolean },
  ) => Promise<boolean>
}

export function useTaskActions(): TaskActions {
  const addToast = useToastStore((s) => s.addToast)

  const retry = useCallback(
    async (taskId: string, attention?: TaskAttention) => {
      if (!(await confirmAccountRetry(attention))) return false
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
      sayRefused(res.reason, ASSIGN_REFUSED, 'Couldn’t assign the task. Please try again.')
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
    async (taskIds: readonly string[], attention?: TaskAttention) => {
      const n = taskIds.length
      if (n === 0) return 0
      if (!(await confirmAccountRetry(attention, n))) return 0
      const { ok, reasons } = await settleAll(taskIds, retryTask)
      if (ok === n) {
        addToast({ type: 'success', message: `Retrying ${countLabel(n, 'task')}.` })
      } else if (ok > 0) {
        addToast({ type: 'info', message: `Retried ${ok} of ${n}. ${refusedSentence(n - ok)}` })
      } else if (reasons.every((r) => r === 'room_archived')) {
        // Trying again changes nothing until Clawboo restarts: say what does.
        addToast({ type: 'error', message: n === 1 ? ROOM_ARCHIVED : ROOMS_ARCHIVED })
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

  const assignToMe = useCallback(
    async (taskId: string) => {
      const res = await assignTaskToPerson(taskId)
      if (res.ok) {
        addToast({ type: 'success', message: 'It’s yours now. Nothing will start it.' })
        return true
      }
      sayRefused(res.reason, ASSIGN_REFUSED, 'Couldn’t assign the task. Please try again.')
      return false
    },
    [addToast],
  )

  const assignToPerson = useCallback(
    async (taskId: string, personId: string, name: string) => {
      const res = await assignTaskToPerson(taskId, personId)
      if (res.ok) {
        addToast({ type: 'success', message: `Assigned to ${name}. Nothing will start it.` })
        return true
      }
      sayRefused(res.reason, ASSIGN_REFUSED, 'Couldn’t assign the task. Please try again.')
      return false
    },
    [addToast],
  )

  const markDone = useCallback(
    async (taskId: string) => {
      let res = await updateStatusResult(taskId, 'done')
      // A check that did not pass holds Done, as in the status menu: a person may
      // override it, on the record, and retrying would only be refused again.
      if (!res.ok && res.reason === 'verification_required') {
        const proceed = await confirm({
          title: 'Complete anyway?',
          message:
            'This task hasn’t passed verification. Completing it is a manual override and will be recorded in the audit log.',
          confirmLabel: 'Complete anyway',
          tone: 'danger',
        })
        if (!proceed) return false
        res = await updateStatusResult(taskId, 'done', { humanOverride: true })
      }
      if (res.ok) return true
      addToast({ type: 'error', message: 'Couldn’t mark the task done. Please try again.' })
      return false
    },
    [addToast],
  )

  const reopen = useCallback(
    async (
      taskId: string,
      comment?: string,
      opts?: {
        onThread?: boolean
        /** It is a person's request: it waits on its lead, and does not go to To do. */
        request?: boolean
      },
    ) => {
      const res = await reopenTask(taskId, comment, opts?.onThread ? { onThread: true } : {})
      if (res.ok) {
        const missed = res.delivery?.status === 'not-delivered' ? res.delivery.reason : null
        const paused = res.delivery?.status === 'queued' && res.delivery.reason === 'paused'
        addToast(
          missed
            ? {
                type: 'info',
                message: opts?.request
                  ? `Reopened, but its lead was not told: ${notDeliveredWhy(missed)}`
                  : `Reopened. It’s back in To do, but ${
                      comment ? 'your note did not reach an agent' : 'it could not start'
                    }: ${notDeliveredWhy(missed)}`,
              }
            : paused
              ? {
                  type: 'info',
                  message: opts?.request
                    ? 'Reopened. Its lead takes it from here after the resume.'
                    : 'Reopened. It’s back in To do, and starts after the resume.',
                }
              : {
                  type: 'success',
                  message: opts?.request
                    ? 'Reopened. Its lead takes it from here.'
                    : 'Reopened. The task is back in To do.',
                },
        )
        return true
      }
      sayRefused(res.reason, REOPEN_REFUSED, 'Couldn’t reopen the task. Please try again.')
      return false
    },
    [addToast],
  )

  const openSettings = useSettingsModalStore((s) => s.openSettings)
  const fixSignIn = useCallback(
    (runtime?: string) => openSettings('runtimes', runtime ? { focusRuntime: runtime } : undefined),
    [openSettings],
  )

  return {
    retry,
    assign,
    dismiss,
    retryMany,
    dismissMany,
    fixSignIn,
    assignToMe,
    assignToPerson,
    markDone,
    reopen,
  }
}
