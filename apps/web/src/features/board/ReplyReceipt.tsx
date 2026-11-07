// What happened to a reply a person just sent on a task, said under it: sent to
// the agent's run, the agent starting on it, waiting for the next run, or not
// sent. A reply on a finished task reaches no one until it runs again, so the note
// offers to reopen it, which starts its agent with the reply, or to send the reply as
// a follow-up task for the same agent.

import { useState } from 'react'
import { Check, Clock, CornerDownRight, Info, RotateCcw } from 'lucide-react'

import { createTaskForAgent, type ReplyDelivery } from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'

import { notDeliveredWhy } from './boardStatus'
import { useTaskActions } from './useTaskActions'

/** The note's words for a delivery, with the agent's name. */
export function receiptText(delivery: ReplyDelivery, name: string): string {
  switch (delivery.status) {
    case 'steered':
      return `Sent to ${name}’s run`
    case 'woke-agent':
      return `${name} is starting on this`
    case 'queued':
      if (delivery.reason === 'in-review') return `${name} will see this after the check`
      if (delivery.reason === 'held')
        return `Clawboo is holding new runs. ${name} will see this when it resumes`
      if (delivery.reason === 'waiting')
        return `${name} will see this when the task it waits on is done`
      return `${name} will see this on the next run`
    case 'not-delivered':
      return `Not sent: ${notDeliveredWhy(delivery.reason)}`
  }
}

export function ReplyReceipt({
  delivery,
  task,
  body,
  onFollowUp,
  onReopened,
}: {
  delivery: ReplyDelivery
  /** The task replied on: the follow-up is filed under it, on its team. */
  task: { id: string; title?: string | null; teamId?: string | null }
  /** The reply, which becomes the follow-up's brief. */
  body: string
  /** A follow-up task was made, with its id. */
  onFollowUp?: (taskId: string) => void
  /** The task was reopened. */
  onReopened?: () => void
}) {
  const name = useFleetStore((s) =>
    delivery.agentId ? (s.agents.find((a) => a.id === delivery.agentId)?.name ?? null) : null,
  )
  const addToast = useToastStore((s) => s.addToast)
  const { reopen } = useTaskActions()
  const [followUp, setFollowUp] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [reopened, setReopened] = useState<'idle' | 'sending' | 'sent'>('idle')
  const who = name ?? 'The agent'
  const sent = delivery.status === 'steered' || delivery.status === 'woke-agent'
  const Icon = sent ? Check : delivery.status === 'queued' ? Clock : Info
  const canFollowUp =
    delivery.status === 'not-delivered' &&
    delivery.reason === 'finished' &&
    !!delivery.agentId &&
    !!task.teamId

  const canReopen = delivery.status === 'not-delivered' && delivery.reason === 'finished'
  // The reply is saved on the task already, and nothing passed it on. Reopening with
  // it passes it on: a run on the task runner has no thread to read it from.
  const reopenIt = async (): Promise<void> => {
    setReopened('sending')
    const ok = await reopen(task.id, body, { onThread: true })
    setReopened(ok ? 'sent' : 'idle')
    if (ok) onReopened?.()
  }

  const sendFollowUp = async (): Promise<void> => {
    if (!delivery.agentId || !task.teamId) return
    setFollowUp('sending')
    const made = await createTaskForAgent({
      title: `Follow up: ${task.title?.trim() || 'Untitled task'}`.slice(0, 500),
      description: body,
      teamId: task.teamId,
      assigneeAgentId: delivery.agentId,
      parentTaskId: task.id,
    })
    if (!made) {
      setFollowUp('idle')
      addToast({ type: 'error', message: 'Couldn’t make the follow-up task. Please try again.' })
      return
    }
    setFollowUp('sent')
    onFollowUp?.(made.id)
  }

  return (
    <div
      data-testid="reply-receipt"
      data-delivery={delivery.status}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1">
        <Icon size={12} strokeWidth={2} aria-hidden className={sent ? 'text-mint' : undefined} />
        {reopened === 'sent'
          ? 'Reopened'
          : followUp === 'sent'
            ? `Sent as a follow-up task for ${who}`
            : receiptText(delivery, who)}
      </span>
      {canReopen && reopened !== 'sent' && followUp !== 'sent' ? (
        <button
          type="button"
          disabled={reopened === 'sending'}
          onClick={() => void reopenIt()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <RotateCcw size={12} strokeWidth={2} aria-hidden />
          Reopen the task
        </button>
      ) : null}
      {canFollowUp && followUp !== 'sent' && reopened !== 'sent' ? (
        <button
          type="button"
          disabled={followUp === 'sending'}
          onClick={() => void sendFollowUp()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <CornerDownRight size={12} strokeWidth={2} aria-hidden />
          Send as a follow-up task
        </button>
      ) : null}
    </div>
  )
}
