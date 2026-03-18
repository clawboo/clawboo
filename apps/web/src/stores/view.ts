import { create } from 'zustand'

// ─── ViewMode ────────────────────────────────────────────────────────────────
// Discriminated union replacing the old flat View type.
// 'chat' is gone — selecting an agent opens chat via { type: 'agent' }.

export type NavView = 'graph' | 'approvals' | 'cost' | 'marketplace' | 'scheduler' | 'system'

export type ViewMode =
  | { type: 'agent'; agentId: string }
  | { type: 'nav'; view: NavView }
  | { type: 'welcome' }
  | { type: 'booZero' }

// ─── Store ───────────────────────────────────────────────────────────────────

interface ViewStore {
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void

  /** Navigate to a NavView (graph, approvals, cost, marketplace, scheduler, system). */
  navigateTo: (view: NavView) => void

  /** Open an agent's chat / detail view. */
  openAgent: (agentId: string) => void

  /** Open the Boo Zero standalone view. */
  openBooZero: () => void
}

export const useViewStore = create<ViewStore>((set) => ({
  viewMode: { type: 'nav', view: 'graph' },

  setViewMode: (mode) => set({ viewMode: mode }),

  navigateTo: (view) => set({ viewMode: { type: 'nav', view } }),

  openAgent: (agentId) => set({ viewMode: { type: 'agent', agentId } }),

  openBooZero: () => set({ viewMode: { type: 'booZero' } }),
}))
