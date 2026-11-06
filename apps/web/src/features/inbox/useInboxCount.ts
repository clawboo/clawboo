import { useMemo } from 'react'

import { useApprovalsStore } from '@/stores/approvals'

import { inboxCount, useInboxStore } from './inboxStore'

/** What the badge says. Zero until the first read lands. */
export function useInboxCount(): number {
  const unread = useInboxStore((s) => s.unread)
  const marks = useInboxStore((s) => s.marks)
  const allMark = useInboxStore((s) => s.allMark)
  const needsYou = useInboxStore((s) => s.needsYou)
  const approvals = useInboxStore((s) => s.approvals)
  // Shell approvals the Gateway socket delivered, which the server may not have
  // mirrored yet. The same id from both sources counts once.
  const pending = useApprovalsStore((s) => s.pendingApprovals)
  // The sidebar renders often, and most renders change none of this.
  return useMemo(
    () => inboxCount({ unread, marks, allMark, needsYou, approvals }, pending.keys()),
    [unread, marks, allMark, needsYou, approvals, pending],
  )
}
