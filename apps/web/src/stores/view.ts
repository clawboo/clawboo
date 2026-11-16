import { create } from 'zustand'
import { scopedLocalStorage } from '@/lib/clientStorage'

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
  'inbox',
  'runtimes',
  'providers',
  'websiteLogins',
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

/** A request for the Board to bring Needs you into view (set by a browser alert
 *  about an approval, or about several things at once, and by a notification
 *  deep link from an app that shows the dashboard). `teamId` is the team to
 *  show, `all` for every team, or null to keep the board's team. */
export interface BoardNeedsYouFocus {
  teamId: string | null
  /** One approval whose card to bring into view and give focus, once it shows. */
  approvalId: string | null
  nonce: number
}

// ─── History ─────────────────────────────────────────────────────────────────
// The dashboard's own back and forward, for the slim top bar an app that shows
// the dashboard in its own window can ask for. A view the person moves to pushes
// the one they left onto `past` and clears `future`, like a browser tab. It is
// bounded and kept in memory only: a reload starts it empty.

/** How many views back (and forward) the history keeps. */
export const VIEW_HISTORY_LIMIT = 50

export interface ViewHistory {
  /** Views left behind, oldest first: back goes to the last one. */
  past: ViewMode[]
  /** Views stepped back from, nearest first: forward goes to the first one. */
  future: ViewMode[]
}

const EMPTY_HISTORY: ViewHistory = { past: [], future: [] }

/** True when two view modes show the same page. A new object for the same page
 *  (Needs you asked for again while the board is open) is not a move. */
export function sameView(a: ViewMode, b: ViewMode): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'agent':
      return a.agentId === (b as typeof a).agentId
    case 'nav':
      return a.view === (b as typeof a).view
    case 'groupChat':
      return (
        a.teamId === (b as typeof a).teamId &&
        (a.roomId ?? null) === ((b as typeof a).roomId ?? null)
      )
    case 'teamspace':
      return a.teamId === (b as typeof a).teamId
    default:
      return true
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface ViewStore {
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void
  /** Show `mode` in place of the current view, leaving nothing in the history:
   *  for a page that went away under the person (its team, agent or room was
   *  deleted), so back never returns to it. */
  replaceViewMode: (mode: ViewMode) => void

  /** The views back and forward step through. */
  viewHistory: ViewHistory
  /** Step back (or forward) to the nearest view `usable` accepts, dropping the
   *  ones it refuses on the way. Returns the view now shown, or null when there
   *  was nowhere to go (and nothing changed). */
  stepViewHistory: (
    direction: 'back' | 'forward',
    usable?: (mode: ViewMode) => boolean,
  ) => ViewMode | null

  /** Navigate to a NavView (graph, board, cost, marketplace, routines, system). */
  navigateTo: (view: NavView) => void

  /** Pending "open this task" request for the Board (consumed once). */
  boardFocus: BoardFocus | null
  /** Switch to the Board and open `taskId` in its full detail drawer. */
  openBoardTask: (taskId: string, teamId?: string | null) => void
  /** The Board took the request (it opened the drawer). */
  clearBoardFocus: () => void

  /** Pending "show Needs you" request for the Board (consumed once). */
  boardNeedsYouFocus: BoardNeedsYouFocus | null
  /** Switch to the Board and bring Needs you into view, and with `approvalId`
   *  that approval's card. */
  openBoardNeedsYou: (teamId?: string | null, approvalId?: string | null) => void
  /** The Board took the request. */
  clearBoardNeedsYouFocus: () => void

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

// Private mode / blocked storage: the layout still works, it just isn't remembered.
const readStored = (key: string): string | null => scopedLocalStorage.getItem(key)
const writeStored = (key: string, value: string): void => scopedLocalStorage.setItem(key, value)

function initialSidebarWidth(): number {
  const n = Number(readStored(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(n) && n > 0 ? clampSidebarWidth(n) : SIDEBAR_NATURAL_WIDTH
}

/** The state for a move to `next`: the view it leaves goes onto `past`, and
 *  `future` empties. The same page again keeps the history as it is, but still
 *  takes the new object, so whatever reacts to a navigation still sees one. */
function moveTo(
  s: Pick<ViewStore, 'viewMode' | 'viewHistory'>,
  next: ViewMode,
): Pick<ViewStore, 'viewMode' | 'viewHistory'> {
  if (sameView(s.viewMode, next)) return { viewMode: next, viewHistory: s.viewHistory }
  return {
    viewMode: next,
    viewHistory: {
      past: [...s.viewHistory.past, s.viewMode].slice(-VIEW_HISTORY_LIMIT),
      future: [],
    },
  }
}

export const useViewStore = create<ViewStore>((set, get) => ({
  viewMode: { type: 'nav', view: 'graph' },

  setViewMode: (mode) => set((s) => moveTo(s, mode)),

  replaceViewMode: (mode) => set({ viewMode: mode }),

  viewHistory: EMPTY_HISTORY,
  stepViewHistory: (direction, usable = () => true) => {
    const { viewMode, viewHistory } = get()
    const back = direction === 'back'
    // Nearest first in both directions.
    const queue = back ? [...viewHistory.past].reverse() : viewHistory.future
    const at = queue.findIndex((m) => usable(m) && !sameView(m, viewMode))
    if (at < 0) return null
    const target = queue[at]!
    const rest = queue.slice(at + 1)
    set(
      back
        ? {
            viewMode: target,
            viewHistory: {
              past: rest.reverse(),
              future: [viewMode, ...viewHistory.future].slice(0, VIEW_HISTORY_LIMIT),
            },
          }
        : {
            viewMode: target,
            viewHistory: {
              past: [...viewHistory.past, viewMode].slice(-VIEW_HISTORY_LIMIT),
              future: rest,
            },
          },
    )
    return target
  },

  navigateTo: (view) => set((s) => moveTo(s, { type: 'nav', view })),

  boardFocus: null,
  // Each request replaces the other kind still waiting, so when both wait for
  // the Board to mount, the newer one is what it shows.
  openBoardTask: (taskId, teamId = null) =>
    set((s) => ({
      ...moveTo(s, { type: 'nav', view: 'board' }),
      boardFocus: { taskId, teamId, nonce: (s.boardFocus?.nonce ?? 0) + 1 },
      boardNeedsYouFocus: null,
    })),
  clearBoardFocus: () => set({ boardFocus: null }),

  boardNeedsYouFocus: null,
  openBoardNeedsYou: (teamId = null, approvalId = null) =>
    set((s) => ({
      ...moveTo(s, { type: 'nav', view: 'board' }),
      boardNeedsYouFocus: {
        teamId,
        approvalId,
        nonce: (s.boardNeedsYouFocus?.nonce ?? 0) + 1,
      },
      boardFocus: null,
    })),
  clearBoardNeedsYouFocus: () => set({ boardNeedsYouFocus: null }),

  openAgent: (agentId) => set((s) => moveTo(s, { type: 'agent', agentId })),

  openBooZero: () => set((s) => moveTo(s, { type: 'booZero' })),

  openGroupChat: (teamId, roomId = null) =>
    set((s) =>
      moveTo(s, roomId ? { type: 'groupChat', teamId, roomId } : { type: 'groupChat', teamId }),
    ),

  openTeamspace: (teamId) => set((s) => moveTo(s, { type: 'teamspace', teamId })),

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
