import { create } from 'zustand'

// ─── ViewMode ────────────────────────────────────────────────────────────────
// Discriminated union replacing the old flat View type.
// 'chat' is gone — selecting an agent opens chat via { type: 'agent' }.

// The `'graph'` nav slot now renders the Atlas (global all-teams view) — a
// canvas-wide Boo Zero hierarchy that shows every team at once. The id is
// kept as `'graph'` for minimal churn across viewMode discriminants and
// keyboard shortcut wiring; the team-scoped Ghost Graph still lives inside
// `GroupChatView` and is unaffected.
// The canonical list of nav views (single source of truth). `NavView` is derived
// from it so the set is enumerable at runtime — e.g. the AppTopBar inline-star
// rule in `lib/topBar.ts` builds its set from this, so adding a view here keeps
// that rule in sync automatically (every nav panel hosts the Star pill inline).
export const NAV_VIEWS = [
  'graph',
  'fleet',
  'cost',
  'marketplace',
  'connectors',
  'routines',
  'system',
  'obs',
  'board',
  'runtimes',
  'providers',
  'memory',
  'governance',
  'capabilities',
  'health',
] as const

export type NavView = (typeof NAV_VIEWS)[number]

export type ViewMode =
  | { type: 'agent'; agentId: string }
  | { type: 'nav'; view: NavView }
  | { type: 'welcome' }
  | { type: 'booZero' }
  | {
      type: 'groupChat'
      teamId: string
      /** One of the team's chat rooms; null/absent = the team's own group chat. */
      roomId?: string | null
    }
  /** The team's overview: its graph and every task from all its rooms. */
  | { type: 'teamspace'; teamId: string }

/** A task the Board should open in its detail drawer the next time it renders
 *  (set by "Open on board" from a chat task card). `nonce` makes a second
 *  request for the same task distinct, so it re-opens after being closed. */
export interface BoardFocus {
  taskId: string
  teamId: string | null
  nonce: number
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface ViewStore {
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void

  /** Navigate to a NavView (graph, board, cost, marketplace, routines, system). */
  navigateTo: (view: NavView) => void

  /** Pending "open this task" request for the Board (consumed once). */
  boardFocus: BoardFocus | null
  /** Switch to the Board and open `taskId` in its full detail drawer. */
  openBoardTask: (taskId: string, teamId?: string | null) => void
  /** The Board took the request (it opened the drawer). */
  clearBoardFocus: () => void

  /** Open an agent's chat / detail view. */
  openAgent: (agentId: string) => void

  /** Open the Boo Zero standalone view. */
  openBooZero: () => void

  /** Open the team group chat view, or one of the team's chat rooms. */
  openGroupChat: (teamId: string, roomId?: string | null) => void

  /** Open the team's overview (graph + tasks from every room). */
  openTeamspace: (teamId: string) => void

  /** Whether the whole left sidebar (team rail + agent column) is collapsed. */
  columnCollapsed: boolean
  toggleColumnCollapsed: () => void
  setColumnCollapsed: (collapsed: boolean) => void
  /** Width of the agent column in px, set by dragging its right edge. */
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
}

/** The agent column's natural width: below it the content is clipped and faded. */
export const SIDEBAR_NATURAL_WIDTH = 236
export const SIDEBAR_MIN_WIDTH = 176
export const SIDEBAR_MAX_WIDTH = 420

const SIDEBAR_WIDTH_KEY = 'clawboo.sidebar.width'
const SIDEBAR_COLLAPSED_KEY = 'clawboo.sidebar.collapsed'

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)))
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode / blocked storage: the layout still works, it just isn't remembered.
  }
}

function initialSidebarWidth(): number {
  const n = Number(readStored(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(n) && n > 0 ? clampSidebarWidth(n) : SIDEBAR_NATURAL_WIDTH
}

export const useViewStore = create<ViewStore>((set) => ({
  viewMode: { type: 'nav', view: 'graph' },

  setViewMode: (mode) => set({ viewMode: mode }),

  navigateTo: (view) => set({ viewMode: { type: 'nav', view } }),

  boardFocus: null,
  openBoardTask: (taskId, teamId = null) =>
    set((s) => ({
      viewMode: { type: 'nav', view: 'board' },
      boardFocus: { taskId, teamId, nonce: (s.boardFocus?.nonce ?? 0) + 1 },
    })),
  clearBoardFocus: () => set({ boardFocus: null }),

  openAgent: (agentId) => set({ viewMode: { type: 'agent', agentId } }),

  openBooZero: () => set({ viewMode: { type: 'booZero' } }),

  openGroupChat: (teamId, roomId = null) =>
    set({
      viewMode: roomId ? { type: 'groupChat', teamId, roomId } : { type: 'groupChat', teamId },
    }),

  openTeamspace: (teamId) => set({ viewMode: { type: 'teamspace', teamId } }),

  columnCollapsed: readStored(SIDEBAR_COLLAPSED_KEY) === '1',
  toggleColumnCollapsed: () =>
    set((s) => {
      writeStored(SIDEBAR_COLLAPSED_KEY, s.columnCollapsed ? '0' : '1')
      return { columnCollapsed: !s.columnCollapsed }
    }),
  setColumnCollapsed: (collapsed) => {
    writeStored(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
    set({ columnCollapsed: collapsed })
  },

  sidebarWidth: initialSidebarWidth(),
  setSidebarWidth: (width) => {
    const next = clampSidebarWidth(width)
    writeStored(SIDEBAR_WIDTH_KEY, String(next))
    set({ sidebarWidth: next })
  },
}))
