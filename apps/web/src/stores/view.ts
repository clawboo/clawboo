import { create } from 'zustand'

// ─── ViewMode ────────────────────────────────────────────────────────────────
// Discriminated union replacing the old flat View type.
// 'chat' is gone — selecting an agent opens chat via { type: 'agent' }.

// The `'graph'` nav slot now renders the Atlas (global all-teams view) — a
// canvas-wide Boo Zero hierarchy that shows every team at once. The id is
// kept as `'graph'` for minimal churn across viewMode discriminants and
// keyboard shortcut wiring; the team-scoped Ghost Graph still lives inside
// `GroupChatView` and is unaffected.
export type NavView = 'graph' | 'approvals' | 'cost' | 'marketplace' | 'scheduler' | 'system'

export type ViewMode =
  | { type: 'agent'; agentId: string }
  | { type: 'nav'; view: NavView }
  | { type: 'welcome' }
  | { type: 'booZero' }
  | { type: 'groupChat'; teamId: string }

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

  /** Open the team group chat view. */
  openGroupChat: (teamId: string) => void

  /** Whether Column 2 (AgentListColumn) is collapsed. */
  columnCollapsed: boolean
  toggleColumnCollapsed: () => void
}

export const useViewStore = create<ViewStore>((set) => ({
  viewMode: { type: 'nav', view: 'graph' },

  setViewMode: (mode) => set({ viewMode: mode }),

  navigateTo: (view) => set({ viewMode: { type: 'nav', view } }),

  openAgent: (agentId) => set({ viewMode: { type: 'agent', agentId } }),

  openBooZero: () => set({ viewMode: { type: 'booZero' } }),

  openGroupChat: (teamId) => set({ viewMode: { type: 'groupChat', teamId } }),

  columnCollapsed: false,
  toggleColumnCollapsed: () => set((s) => ({ columnCollapsed: !s.columnCollapsed })),
}))
