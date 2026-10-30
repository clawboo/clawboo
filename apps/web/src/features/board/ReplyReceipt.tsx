// What happened to a reply a person just sent on a task, said under it: sent to
// the agent's run, the agent starting on it, waiting for the next run, or not
// sent. A reply on a finished task cannot reach it (the task will not run
// again), so the note offers to send the reply as a follow-up task for the same
// agent instead.

import { useState } from 'react'
import { Check, Clock, CornerDownRight, Info } from 'lucide-react'

import { createTaskForAgent, type ReplyDelivery } from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'

/** The note's words for a delivery, with the agent's name. */
export function receiptText(delivery: ReplyDelivery, name: string): string {
  switch (delivery.status) {
    case 'steered':
      return `Sent to ${name}’s run`
    case 'woke-agent':
      return `${name} is starting on this`
    case 'queued':
      if (delivery.reason === 'in-review') return `${name} will see this after the check`
      if (delivery.reason === 'waiting')
        return `${name} will see this when the task it waits on is done`
      return `${name} will see this on the next run`
    case 'not-delivered':
      if (delivery.reason === 'finished') return 'Not sent: the task is finished'
      if (delivery.reason === 'unassigned') return 'Not sent: no agent has this task'
      return 'Not sent: something went wrong'
  }
}

export function ReplyReceipt({
  delivery,
  task,
  body,
  onFollowUp,
}: {
  delivery: ReplyDelivery
  /** The task replied on: the follow-up is filed under it, on its team. */
  task: { id: string; title?: string | null; teamId?: string | null }
  /** The reply, which becomes the follow-up's brief. */
  body: string
  /** A follow-up task was made, with its id. */
  onFollowUp?: (taskId: string) => void
}) {
  const name = useFleetStore((s) =>
    delivery.agentId ? (s.agents.find((a) => a.id === delivery.agentId)?.name ?? null) : null,
  )
  const addToast = useToastStore((s) => s.addToast)
  const [followUp, setFollowUp] = useState<'idle' | 'sending' | 'sent'>('idle')
  const who = name ?? 'The agent'
  const sent = delivery.status === 'steered' || delivery.status === 'woke-agent'
  const Icon = sent ? Check : delivery.status === 'queued' ? Clock : Info
  const canFollowUp =
    delivery.status === 'not-delivered' &&
    delivery.reason === 'finished' &&
    !!delivery.agentId &&
    !!task.teamId

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
        {followUp === 'sent' ? `Sent as a follow-up task for ${who}` : receiptText(delivery, who)}
      </span>
      {canFollowUp && followUp !== 'sent' ? (
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
