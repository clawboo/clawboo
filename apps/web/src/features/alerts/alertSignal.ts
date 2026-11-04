// The newest event that may have changed what needs a person.
//
// `RunStatusBridge` holds the app's one live tail of the event log and writes
// the newest trigger's `seq` here, so the alerts react to the same stream
// instead of opening a second one or polling.

import { create } from 'zustand'

interface AlertSignalState {
  /** The highest trigger `seq` seen so far (0 before any). */
  seq: number
  note(seq: number): void
}

export const useAlertSignal = create<AlertSignalState>((set, get) => ({
  seq: 0,
  note(seq) {
    if (seq > get().seq) set({ seq })
  },
}))
