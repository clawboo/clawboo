// The newest event that may have changed what needs a person.
//
// `RunStatusBridge` holds the app's one live tail of the event log and writes
// the newest trigger's `seq` here, so the alerts react to the same stream
// instead of opening a second one or polling. The person's inbox wakes on the
// same tail, on a wider set of reasons: it also has to notice what is merely new,
// and that an approval was answered.

import { create } from 'zustand'

interface AlertSignalState {
  /** The highest trigger `seq` seen so far (0 before any). */
  seq: number
  note(seq: number): void
  /** Bumps each time the person's inbox may have changed. */
  inbox: number
  /** The highest inbox trigger `seq` seen so far. */
  inboxEvent: number
  /** Where the board's record of task changes stood when last told. */
  boardActivity: number
  /** When this person last marked something read, in any browser. */
  boardReads: number
  noteInboxEvent(seq: number): void
  noteBoardActivity(seq: number, read?: number): void
  /** Something other than the tail says the inbox should be read again. */
  pokeInbox(): void
}

export const useAlertSignal = create<AlertSignalState>((set, get) => ({
  seq: 0,
  note(seq) {
    if (seq > get().seq) set({ seq })
  },
  inbox: 0,
  inboxEvent: 0,
  boardActivity: 0,
  boardReads: 0,
  noteInboxEvent(seq) {
    if (seq > get().inboxEvent) set((s) => ({ inboxEvent: seq, inbox: s.inbox + 1 }))
  },
  noteBoardActivity(seq, read = 0) {
    const { boardActivity, boardReads } = get()
    if (seq <= boardActivity && read <= boardReads) return
    set((s) => ({
      boardActivity: Math.max(seq, boardActivity),
      boardReads: Math.max(read, boardReads),
      inbox: s.inbox + 1,
    }))
  },
  pokeInbox() {
    set((s) => ({ inbox: s.inbox + 1 }))
  },
}))
