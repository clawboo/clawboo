// The drawer's reply box: a person's reply to the agent a task belongs to. The
// line under it says what sending does for the task as it stands; once sent, a
// note under the reply says where it went (see ReplyReceipt).

import { useState } from 'react'

import { postTaskComment, type ReplyDelivery } from '@/lib/boardClient'
import { Button } from '@/features/shared/Button'
import { useToastStore } from '@/stores/toast'

/** What sending a reply does, for a task in `status`. */
export function replyHint(status: string, agentName: string | null): string {
  if (status === 'done' || status === 'cancelled')
    return 'This task is finished. You can send your reply as a follow-up task.'
  if (!agentName) return 'No agent has this task. Your reply is saved on it.'
  if (status === 'in_progress') return `${agentName} gets this in the current run.`
  if (status === 'blocked' || status === 'todo') return `Sending starts ${agentName} on this again.`
  if (status === 'in_review') return `${agentName} reads this after the check.`
  return `${agentName} reads this when the task starts.`
}

export function TaskReplyBox({
  taskId,
  status,
  agentName,
  onSent,
}: {
  taskId: string
  status: string
  /** The agent the task belongs to, by name; null when nobody has it. */
  agentName: string | null
  onSent: (sent: { commentId: string | null; delivery: ReplyDelivery | null; body: string }) => void
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  const send = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    const res = await postTaskComment(taskId, body)
    setSending(false)
    if (!res.ok) {
      addToast({ type: 'error', message: 'Couldn’t send your reply. Please try again.' })
      return
    }
    setDraft('')
    onSent({ commentId: res.commentId, delivery: res.delivery, body })
  }

  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <div className="rounded-lg border border-border transition-colors focus-within:border-border-strong">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          aria-label="Reply"
          placeholder={agentName ? `Reply to ${agentName}…` : 'Add a comment…'}
          data-testid="task-reply"
          className="block w-full resize-none bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none!"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <span className="min-w-0 flex-1 px-1 text-xs text-muted-foreground">
            {replyHint(status, agentName)}
          </span>
          <Button type="submit" size="sm" variant="primary" disabled={!draft.trim() || sending}>
            Send
          </Button>
        </div>
      </div>
    </form>
  )
}
