// What each agent is doing right now, as derived from the obs event tail.
//
// Written by exactly one producer (`RunStatusBridge`, which holds the app's
// single global obs stream) and read by every Boo card. A store rather than a
// hook per card because the alternative is one EventSource per visible agent.
//
// Deliberately NOT persisted: this is live run state, meaningless after a
// reload, and re-derived from the backfill within a second of mount.

import { create } from 'zustand'

interface RunActivityState {
  /** agentId → a short line like `editing pricing.css` or `pnpm test`. */
  byAgent: Map<string, string>
  /** Replace the whole map. The producer folds the full window each frame, so a
   *  merge would strand lines for agents that have gone quiet. */
  setAll: (next: Map<string, string>) => void
}

export const useRunActivityStore = create<RunActivityState>((set) => ({
  byAgent: new Map(),
  setAll: (next) => set({ byAgent: next }),
}))
