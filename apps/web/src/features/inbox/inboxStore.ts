// What this page knows about the person's inbox, held for the badge and the list.
//
// The server is the truth. Marks sent from this page apply at once and are kept
// next to the snapshot rather than editing it, because seqs only grow: a read that
// left before a mark landed cannot bring the task back, while a newer change on the
// same task, with a higher seq, still does.

import { apiFetch } from '@clawboo/control-client'
import { create } from 'zustand'

import { useAlertSignal } from '@/features/alerts/alertSignal'

/** GET /api/board/inbox. */
export interface InboxSnapshot {
  unread: ReadonlyArray<{ id: string; seq: number }>
  needsYou: readonly string[]
  approvals: readonly string[]
  /** The newest change the read knew of. */
  through: number
}

interface InboxState {
  unread: Readonly<Record<string, number>>
  needsYou: readonly string[]
  approvals: readonly string[]
  /** The newest change this page marked read, per task. */
  marks: Readonly<Record<string, number>>
  /** The newest change this page marked read across the whole board. */
  allMark: number
  /** Bumps after each read lands, at most once per burst of events. The list follows
   *  this rather than the events themselves. */
  revision: number
  apply(snapshot: InboxSnapshot): void
  /** The person opened the task as of `seq`. Resolves false when the server refused,
   *  with the mark taken back. */
  markRead(taskId: string, seq: number): Promise<boolean>
  /** The person marked everything read as of `through`, or one team's tasks.
   *  `shown` is what the page knows that team holds, cleared at once. Resolves false
   *  when the server refused, with the marks taken back. */
  markAllRead(opts: {
    through: number
    teamId?: string
    shown?: ReadonlyArray<{ id: string; seq: number }>
  }): Promise<boolean>
}

const EMPTY = {
  unread: {},
  needsYou: [],
  approvals: [],
  marks: {},
  allMark: 0,
  revision: 0,
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

/** A mark did not land, so what the page shows may be wrong: read again. */
const readAgain = (): void => useAlertSignal.getState().pokeInbox()

/**
 * Take back marks a refused request made, unless a newer one has replaced them. What was
 * there before stays gone rather than coming back: it may be another request's that is
 * also about to fail, and it would then hide the task here while the server says it is
 * unread. A mark that did land needs no holding, because the read that follows knows it.
 */
function withoutMarks(
  marks: Readonly<Record<string, number>>,
  taken: ReadonlyArray<{ id: string; seq: number }>,
): Record<string, number> {
  const next = { ...marks }
  for (const { id, seq } of taken) if ((next[id] ?? 0) <= seq) delete next[id]
  return next
}

export const useInboxStore = create<InboxState>((set) => ({
  ...EMPTY,
  apply(snapshot) {
    set((s) => ({
      unread: Object.fromEntries(snapshot.unread.map((t) => [t.id, t.seq])),
      needsYou: snapshot.needsYou,
      approvals: snapshot.approvals,
      revision: s.revision + 1,
    }))
  },
  async markRead(taskId, seq) {
    set((s) => ({ marks: { ...s.marks, [taskId]: Math.max(seq, s.marks[taskId] ?? 0) } }))
    let ok = false
    try {
      const res = await apiFetch(`/api/board/${encodeURIComponent(taskId)}/read`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ through: seq }),
      })
      ok = res.ok
    } catch {
      // Read below as refused.
    }
    if (ok) return true
    set((s) => ({ marks: withoutMarks(s.marks, [{ id: taskId, seq }]) }))
    readAgain()
    return false
  },
  async markAllRead({ through, teamId, shown }) {
    // The whole board is one mark. Which tasks a team holds is the server's to say,
    // so only what the page was showing clears before the read that follows.
    if (!teamId) set((s) => ({ allMark: Math.max(through, s.allMark) }))
    else if (shown) {
      set((s) => ({
        marks: {
          ...s.marks,
          ...Object.fromEntries(shown.map((t) => [t.id, Math.max(t.seq, s.marks[t.id] ?? 0)])),
        },
      }))
    }
    let ok = false
    try {
      const res = await apiFetch('/api/board/inbox/read', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(teamId ? { through, teamId } : { through }),
      })
      ok = res.ok
    } catch {
      // Read below as refused.
    }
    if (!ok) {
      // As `withoutMarks` says, for the one mark of the whole board too.
      set((s) =>
        teamId
          ? { marks: withoutMarks(s.marks, shown ?? []) }
          : { allMark: s.allMark > through ? s.allMark : 0 },
      )
    }
    readAgain()
    return ok
  },
}))

/** The tasks unread right now, as far as this page knows. */
export function unreadIds(state: Pick<InboxState, 'unread' | 'marks' | 'allMark'>): string[] {
  return Object.entries(state.unread)
    .filter(([id, seq]) => seq > Math.max(state.marks[id] ?? 0, state.allMark))
    .map(([id]) => id)
}

/** What the badge says: everything that wants the person, each thing once.
 *  `gatewayApprovals` are shell approvals the socket delivered, which the server
 *  may not have mirrored yet. */
export function inboxCount(
  state: Pick<InboxState, 'unread' | 'marks' | 'allMark' | 'needsYou' | 'approvals'>,
  gatewayApprovals: Iterable<string>,
): number {
  const tasks = new Set([...unreadIds(state), ...state.needsYou])
  const approvals = new Set([...state.approvals, ...gatewayApprovals])
  return tasks.size + approvals.size
}

/** Test helper. */
export function resetInboxStore(): void {
  useInboxStore.setState(EMPTY)
}
