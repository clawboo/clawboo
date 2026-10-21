import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core'
import { KanbanSquare, Plus, RefreshCw } from 'lucide-react'
import { BooAvatar, TINTS } from '@clawboo/ui'
import { delegationTargetOf } from '@clawboo/board-core'

import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'
import { useEditorStore } from '@/stores/editor'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useFleetStore } from '@/stores/fleet'
import { fetchBoardResult, type BoardTask } from '@/lib/boardClient'
import {
  fetchSchedules,
  runScheduleNow,
  type RoutineOccurrences,
  type ScheduleRecord,
} from '@/lib/schedulesClient'
import { prefersReducedMotion } from '@/lib/prefersReducedMotion'
import { useReadSequencer } from '@/lib/useReadSequencer'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Skeleton } from '@/features/shared/Skeleton'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'
import { hasOpenLayer } from '@/features/shared/useDismissableLayer'
import { RoutineDialog, type RoutineDirectory } from '@/features/routines/RoutineDialog'
import { EMPTY_DIRECTORY, loadRoutineDirectory } from '@/features/routines/routineDirectory'

import { TaskDetailDrawer } from './TaskDetailDrawer'
import { NeedsYouItems, NeedsYouLane, useNeedsYou } from './NeedsYouColumn'
import { NewTaskDialog } from './NewTaskDialog'
import { TaskCard, taskOwnerOf } from './TaskCard'
import {
  BOARD_STATUS_COLUMNS,
  NEEDS_YOU_COLUMN,
  STATUS_LABEL,
  boardColumnOf,
  canTransition,
  statusLabel,
  statusOptions,
} from './boardStatus'
import { BOARD_ACCESSIBILITY, CALENDAR_ACCESSIBILITY, OTHER_COLUMN } from './boardAnnouncements'
import { useStatusMutation, type StatusCommit } from './useStatusMutation'
import { finishNeedFor, finishPromptNeeded, isFinishStatus, sitsOnOtherDay } from './finishMove'
import { resolveDrop } from './resolveDrop'
import { boardCollision } from './boardCollision'
import {
  BOTTOM_PAD,
  CalendarGrid,
  GUTTER_W,
  HEADER_H,
  NEEDS_YOU_CAP,
  calendarStamp,
  columnHue,
  type Landing,
} from './calendar/CalendarGrid'
import { CalendarToolbar } from './calendar/CalendarToolbar'
import { RoutineRunPopover, routineName } from './calendar/RoutineRun'
import {
  countLabel,
  dayMonth,
  rangeRelation,
  rangeTitle,
  relativeDayWord,
  shortDate,
  sinceLabel,
} from './calendar/calendarFormat'
import { FindPopover } from './calendar/FindPopover'
import { matchBoard, type FindResult } from './calendar/findModel'
import { summaryParts } from './calendar/seenModel'
import { useSeenBoard } from './calendar/useSeenBoard'
import {
  bucketAll,
  bucketRuns,
  bucketTasks,
  buildRange,
  dayKey,
  isFinishedStatus,
  isSameDay,
  landingAnchor,
  localeWeekStart,
  localeWeekend,
  rangeContains,
  shiftFocus,
  startOfDay,
  taskAnchor,
  taskPlacedAt,
  type CalendarMode,
  type DayRuns,
} from './calendar/calendarModel'
import { useCalendarClock } from './calendar/useCalendarClock'
import { useRoutineRuns } from './calendar/useRoutineRuns'

/** The since line's actions: quiet links in the header's subtitle. */
const SINCE_ACTION =
  'shrink-0 cursor-pointer rounded font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2'

/** Nothing in the set: what the grid gets while no card is marked. */
const EMPTY_SET: ReadonlySet<string> = new Set()
/** No routine runs on any day: the All view, or the switch hiding them. */
const NO_RUNS = new Map<string, DayRuns<RoutineOccurrences>[]>()

/** Where today's row is, relative to what is on screen; null while it shows. */
type TodayDirection = 'up' | 'down' | 'left' | 'right' | null

/** How long a card the person just set down shows its settle. */
const SETTLE_MS = 400
/** How long the cards an agent just moved stay marked, and how many at once. */
const ARRIVAL_MS = 1600
const ARRIVAL_CAP = 6
/** A read this soon after the person acted shows their own change, not an agent's. */
const ARRIVAL_QUIET_MS = 6000
/** A read this long after the one before it follows a hidden tab: too much has
 *  changed to mark any of it. */
const ARRIVAL_MAX_GAP_MS = 15_000
/** How long a new range takes to slide in. */
const RANGE_SLIDE_MS = 240
/** How long the Today ping waits for a smooth scroll to end, where `scrollend`
 *  never comes. */
const SCROLL_END_FALLBACK_MS = 700
/** How long today's ping plays (its CSS animation, with a little to spare). */
const PING_MS = 700
/** The lifted card's width when the card it came from can't be measured: about
 *  a card's width in a status column at its narrowest. */
const OVERLAY_FALLBACK_W = 200
/** The lifted card flies back to its cell when letting go does not move it at once. */
const DROP_RETURN: DropAnimation = { duration: 200, easing: 'cubic-bezier(0.32,0.72,0,1)' }

// The status columns, in lifecycle order, after the Needs you column. Derived from
// the shared status metadata so the columns and the drawer's status editor never
// drift on labels or ordering. `in_review` shares In progress (it is automated
// verification, shown with a Verifying badge) and `blocked` always needs a person,
// so neither has a column of its own.
const COLUMNS: { id: string; label: string }[] = BOARD_STATUS_COLUMNS.map((id) => ({
  id,
  label: STATUS_LABEL[id],
}))
const COLUMN_IDS = new Set(COLUMNS.map((c) => c.id))
// `OTHER_COLUMN` (the catch-all for a status outside the canonical 7, so such a
// task isn't silently dropped) lives in `boardAnnouncements` alongside the
// label mapping the screen-reader announcements read, so the column and its
// spoken name can't drift apart.

/** The column a task is drawn in, folding off-list statuses into Other. */
function drawnColumnOf(task: BoardTask): string {
  const col = boardColumnOf(task)
  return col === NEEDS_YOU_COLUMN || COLUMN_IDS.has(col) ? col : OTHER_COLUMN.id
}

/** The key that says the calendar's range changed (`all` for the All view). */
function rangeKeyOf(range: { mode: string; start: number } | null): string {
  return range ? `${range.mode}:${range.start}` : 'all'
}

/** Whether letting the card go over `over` moves it at once, with nothing to
 *  ask: a legal column other than its own, not a move back to To do that
 *  unassigns its agent, and not a finishing move that asks first (a day to pick,
 *  a cancel to confirm, a run to stop, a failed check to override). */
function dropCommitsAtOnce(
  task: BoardTask,
  over: string | null,
  dropDisabled: (columnId: string) => boolean,
  now: number,
): boolean {
  if (!over || over === task.status || over === boardColumnOf(task) || dropDisabled(over))
    return false
  if (over === 'todo' && task.assigneeAgentId) return false
  return !(isFinishStatus(over) && finishPromptNeeded(finishNeedFor(task, over, now)))
}

/** A task with no agent bound waits in Needs you once it is in To do. */
function unboundTodo(task: BoardTask, to: string): boolean {
  if (to !== 'todo') return false
  const sdid = typeof task['sourceDelegationId'] === 'string' ? task['sourceDelegationId'] : null
  return delegationTargetOf(sdid) == null
}

// ─── View preferences ───────────────────────────────────────────────────────
// Remembered per browser: a convenience, so a missing or unreadable store just
// means the defaults.

const PREFS_KEY = 'clawboo.board.calendar'
const MODES: readonly CalendarMode[] = ['day', 'week', 'month', 'all']
interface BoardViewPrefs {
  mode: CalendarMode
  showRoutines: boolean
  cancelledOpen: boolean
}
const DEFAULT_PREFS: BoardViewPrefs = { mode: 'week', showRoutines: true, cancelledOpen: false }

function readPrefs(): BoardViewPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const p = JSON.parse(raw) as Partial<BoardViewPrefs>
    return {
      mode: p.mode && MODES.includes(p.mode) ? p.mode : 'week',
      showRoutines: typeof p.showRoutines === 'boolean' ? p.showRoutines : true,
      cancelledOpen: typeof p.cancelledOpen === 'boolean' ? p.cancelledOpen : false,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

// Whether the person opened or folded the Earlier row, for this tab only. Until
// they do, it opens when it holds work that is running or waiting to start.
const EARLIER_KEY = 'clawboo.board.earlierOpen'

function readEarlierChoice(): boolean | null {
  try {
    const v = window.sessionStorage.getItem(EARLIER_KEY)
    return v === 'true' ? true : v === 'false' ? false : null
  } catch {
    return null
  }
}

function writeEarlierChoice(open: boolean): void {
  try {
    window.sessionStorage.setItem(EARLIER_KEY, String(open))
  } catch {
    // Blocked storage: the choice holds until the board closes.
  }
}

function writePrefs(prefs: BoardViewPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Private mode or blocked storage: the view still works, it just forgets.
  }
}

/** True when a keystroke is meant for whatever has focus, not for the board. */
function keyBelongsElsewhere(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return true
  const t = e.target
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  if (t.closest('input, textarea, select, [role="listbox"], [role="menu"], [role="dialog"]'))
    return true
  // The segmented control and the Routines toggle are buttons, and arrow keys on
  // a focused radio group conventionally move within it.
  return t.closest('[role="radiogroup"]') != null && e.key.startsWith('Arrow')
}

/** An in-flight drag move: the target status, and when it was made (a move
 *  that finishes the task puts it on that day). */
interface MoveOverride {
  status: string
  at: number
}

/** Where the board should scroll to, and how. */
interface ViewTarget {
  /** A day's row, or null for the top of the grid. */
  day: number | null
  /** `top` puts the row at the top; `nearest` scrolls only as far as it takes. */
  align: 'top' | 'nearest'
  /** Animate it, when the person asked for it and motion is welcome. */
  smooth?: boolean
  /** Also bring the Needs you column into view and give today's cell focus. */
  needsYou?: boolean
  /** A card to bring into view instead of a row. */
  cardId?: string
  /** Ping today's date once its row is in view, and no sooner than this many ms
   *  after the row is reached (a new range is still sliding in). Unset: no ping. */
  pingAfterMs?: number
  /** Give the card focus and flash it once it is in view, so the eye finds it. */
  flash?: boolean
}

/** A value made safe for a quoted attribute selector. */
function attrValue(v: string): string {
  return v.replace(/["\\]/g, '\\$&')
}

export function BoardPanel() {
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const boardFocus = useViewStore((s) => s.boardFocus)
  const addToast = useToastStore((s) => s.addToast)

  const [teamFilter, setTeamFilter] = useState<string>(selectedTeamId ?? 'all')
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loaded, setLoaded] = useState(false) // false until the first fetch resolves → skeleton
  const [fetchOk, setFetchOk] = useState(true) // false when the last fetch failed → error/retry
  // When the board last read the server. A routine run before then has fired, and
  // its task (if it makes one) is already on the board.
  const [readAt, setReadAt] = useState(0)
  // Mirrors `loaded` for the refresh closure so `refresh` stays dep-stable
  // (`[teamFilter]`) and the 5s poll doesn't re-create the interval each load.
  const loadedRef = useRef(false)
  // Reads overlap by design here (the 5s poll, Refresh/Retry, the post-create reconcile)
  // and a local commit can land between a GET being issued and its response arriving, so
  // the board snapshot is sequenced last-write-wins. See useReadSequencer for the two
  // staleness rules; the drag path is exactly why a plain generation counter isn't enough.
  const reads = useReadSequencer()
  // What changed while the person was away, kept per team filter.
  const {
    summary: seenSum,
    dotted,
    pending: pendingSeen,
    noteBoardRead,
    acknowledge: acknowledgeSeen,
    markAllSeen,
    absorbTask,
  } = useSeenBoard(teamFilter)
  const tasksRef = useRef<BoardTask[]>([])
  tasksRef.current = tasks
  // Find: the button it opened from, while it is open.
  const [findAnchor, setFindAnchor] = useState<HTMLElement | null>(null)
  // The Needs you task last brought into view, so its card is shown even past the cap.
  const [needsYouShow, setNeedsYouShow] = useState<string | null>(null)

  // ── Calendar state ──
  const [prefs, setPrefs] = useState<BoardViewPrefs>(readPrefs)
  const updatePrefs = useCallback((patch: Partial<BoardViewPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      writePrefs(next)
      return next
    })
  }, [])
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const now = useCalendarClock()
  const weekStartsOn = useMemo(() => localeWeekStart(), [])
  const weekend = useMemo(() => localeWeekend(), [])
  const [focusDay, setFocusDay] = useState(() => startOfDay(Date.now()))
  // A board left open past midnight follows the new day, as long as it was showing
  // the day that ended; a person who paged elsewhere stays where they are.
  const todayStart = startOfDay(now)
  const lastTodayRef = useRef(todayStart)
  useEffect(() => {
    const previous = lastTodayRef.current
    if (previous === todayStart) return
    lastTodayRef.current = todayStart
    setFocusDay((f) =>
      (
        prefs.mode === 'all' || prefs.mode === 'day'
          ? isSameDay(f, previous)
          : rangeContains(buildRange(prefs.mode, f, weekStartsOn), previous)
      )
        ? todayStart
        : f,
    )
    // Only the day turning matters here; the mode is read as it is at that moment.
  }, [todayStart])
  // The Today view is today alone, so it follows the clock rather than the date
  // the person last paged to.
  const range = useMemo(
    () =>
      prefs.mode === 'all'
        ? null
        : buildRange(prefs.mode, prefs.mode === 'day' ? todayStart : focusDay, weekStartsOn),
    [prefs.mode, focusDay, weekStartsOn, todayStart],
  )
  const rangeRef = useRef(range)
  rangeRef.current = range
  // The date the person picked, from the gutter or the date picker. Its row is lit
  // across the board until they pick it again, press Escape, or page away from it.
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  useEffect(() => {
    if (selectedDay != null && !(range && rangeContains(range, selectedDay))) setSelectedDay(null)
  }, [range, selectedDay])
  const {
    routines,
    settled: runsSettled,
    timeZone,
    refresh: refreshRuns,
  } = useRoutineRuns(range, teamFilter)
  const [runPopover, setRunPopover] = useState<{
    run: RoutineOccurrences
    anchor: HTMLElement
  } | null>(null)
  const [routineDialogId, setRoutineDialogId] = useState<string | null>(null)
  const [routineRecords, setRoutineRecords] = useState<ScheduleRecord[]>([])
  const [directory, setDirectory] = useState<RoutineDirectory>(EMPTY_DIRECTORY)
  const [announcement, setAnnouncement] = useState('')
  // The card just added or moved, kept in sight in a busy cell.
  const [lastTouchedId, setLastTouchedId] = useState<string | null>(null)
  // A card "Open on board" asked for, and how many board reads have missed it.
  const [revealId, setRevealId] = useState<string | null>(null)
  const revealMissesRef = useRef(0)
  const revealFlashRef = useRef(false)
  // Bring a card into view, flashing it and giving it focus; or, when its drawer
  // is opening over it, only into view, so focus stays with the drawer. The
  // effect that does it waits for the board to hold the task (further down).
  const revealTask = useCallback((taskId: string, focus = true) => {
    setLastTouchedId(taskId)
    revealFlashRef.current = focus
    revealMissesRef.current = 0
    setRevealId(taskId)
  }, [])
  // Whether today's row, and today's Needs you cell, are on screen. Unknown counts
  // as on screen, so a board that has not been laid out yet says nothing.
  const [visibility, setVisibility] = useState({ today: true, needsYou: true })
  const todayVisibleRef = useRef(true)
  // Which way today lies when it is not on screen, so the Today button can point.
  const [todayDirection, setTodayDirection] = useState<TodayDirection>(null)
  // More columns off to the right: a soft edge says so.
  const [moreRight, setMoreRight] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Optimistic drag moves: taskId → target status, laid on top of `tasks` so the card
  // sits in its new column while the PATCH is in flight. Short-lived: cleared the
  // moment the mutation resolves (committed into `tasks` on success, or rolled back).
  const [overrides, setOverrides] = useState<Record<string, MoveOverride>>({})
  // The card being dragged, by id. Its fields are read from the latest board
  // state on every render, so a poll that lands mid-drag (an agent claims the
  // card) updates which columns take it; the copy taken at pickup stands in only
  // if the card leaves the board while it is held.
  const [activeId, setActiveId] = useState<string | null>(null)
  const pickedRef = useRef<BoardTask | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  // The lifted card keeps the width of the card it came from.
  const [overlayWidth, setOverlayWidth] = useState(OVERLAY_FALLBACK_W)
  // The card the person just set down, and the cards an agent just moved. Each is
  // marked for a moment, then drawn at rest again.
  const [settleId, setSettleId] = useState<string | null>(null)
  const [arrivedIds, setArrivedIds] = useState<ReadonlySet<string>>(EMPTY_SET)
  // Bumps when Today or T has brought today into view; the grid replays its ping.
  const [todayPing, setTodayPing] = useState(0)
  // When the person last changed the board, and what the last read found: each
  // task's column, when it landed, and for which team and range. Together they
  // tell an agent's move apart from the person's own.
  const lastActionAtRef = useRef(0)
  const lastReadRef = useRef<{ columns: Map<string, string>; at: number; scope: string } | null>(
    null,
  )
  // Timers that outlive a render, cleared when the board closes.
  const fxRef = useRef<{
    settle: number
    arrived: number
    pingClear: number
    stopPing: (() => void) | null
  }>({
    settle: 0,
    arrived: 0,
    pingClear: 0,
    stopPing: null,
  })
  const mutate = useStatusMutation()
  const sensors = useSensors(
    // A mouse or pen drags a card from anywhere on it, and touch from its grip.
    // distance:5 means a press that does not move is a click, which opens the card.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Keyboard DnD: focus a card's grip, Space to pick up, arrows to move, Space to drop,
    // Esc to cancel. Uses the default coordinate getter (25px/arrow, matched by the
    // lifted card's overlap; see boardCollision); crisp column-to-column snapping
    // is a follow-up.
    useSensor(KeyboardSensor),
  )

  // ── Marks on cards: settled, arrived ──
  const markAction = useCallback(() => {
    lastActionAtRef.current = Date.now()
  }, [])

  const settle = useCallback((taskId: string) => {
    const fx = fxRef.current
    window.clearTimeout(fx.settle)
    setSettleId(taskId)
    fx.settle = window.setTimeout(() => setSettleId((s) => (s === taskId ? null : s)), SETTLE_MS)
  }, [])

  // A card the person asked to see flashes once it is in view, as an agent's
  // arrival does, so the eye finds it.
  const flashCard = useCallback((taskId: string) => {
    const fx = fxRef.current
    window.clearTimeout(fx.arrived)
    setArrivedIds(new Set([taskId]))
    fx.arrived = window.setTimeout(() => setArrivedIds(EMPTY_SET), ARRIVAL_MS)
  }, [])

  // Compares a read with the one before it and marks the cards an agent put
  // somewhere new: a task the board had not seen, or one whose column changed. It
  // marks nothing on the first read, after the team or range changed, soon after
  // the person changed something themselves, or after a long gap (a hidden tab,
  // where everything would seem to arrive at once). Needs you keeps its own list,
  // so a task that went there is left out.
  const noteArrivals = useCallback((read: BoardTask[], team: string) => {
    const at = Date.now()
    const scope = `${team}|${rangeKeyOf(rangeRef.current)}`
    const columns = new Map(read.map((t) => [t.id, boardColumnOf(t)]))
    const previous = lastReadRef.current
    lastReadRef.current = { columns, at, scope }
    if (
      !previous ||
      previous.scope !== scope ||
      at - previous.at > ARRIVAL_MAX_GAP_MS ||
      at - lastActionAtRef.current < ARRIVAL_QUIET_MS
    )
      return
    const arrived: string[] = []
    for (const [id, column] of columns) {
      if (column === NEEDS_YOU_COLUMN || previous.columns.get(id) === column) continue
      arrived.push(id)
      if (arrived.length === ARRIVAL_CAP) break
    }
    if (arrived.length === 0) return
    const fx = fxRef.current
    window.clearTimeout(fx.arrived)
    setArrivedIds(new Set(arrived))
    fx.arrived = window.setTimeout(() => setArrivedIds(EMPTY_SET), ARRIVAL_MS)
  }, [])

  useEffect(() => {
    const fx = fxRef.current
    return () => {
      window.clearTimeout(fx.settle)
      window.clearTimeout(fx.arrived)
      window.clearTimeout(fx.pingClear)
      fx.stopPing?.()
    }
  }, [])

  // ── Where the board scrolls ──
  // Every request to show a day, a card or Needs you goes through one place. A
  // request is kept until it lands, because rows can still grow after the first
  // pass (the range's routine runs arrive a moment later and unfold their days),
  // which can leave the scroll stopped short at the bottom of a grid that was not
  // tall enough yet. A person scrolling takes over and cancels it.
  const [viewRequest, setViewRequest] = useState<{ n: number; target: ViewTarget | null }>({
    n: 0,
    target: null,
  })
  const requestView = useCallback(
    (target: ViewTarget) => setViewRequest((r) => ({ n: r.n + 1, target })),
    [],
  )
  const pendingViewRef = useRef<ViewTarget | null>(null)
  const lastViewRequestRef = useRef(0)

  // Today's date pings once the view has come to rest on it: when a smooth scroll
  // ends (`scrollend`, or a fallback where it never fires), and no sooner than
  // `minDelayMs`. A newer ping, or the board closing, puts out one still waiting.
  const pingToday = useCallback((el: HTMLElement, moving: boolean, minDelayMs: number) => {
    const fx = fxRef.current
    fx.stopPing?.()
    const startedAt = Date.now()
    let timer = 0
    const bump = () => {
      fx.stopPing = null
      setTodayPing((n) => n + 1)
      // Put it out once it has played, so a grid redrawn for another range or
      // view does not play it again.
      window.clearTimeout(fx.pingClear)
      fx.pingClear = window.setTimeout(() => setTodayPing(0), PING_MS)
    }
    const atRest = () => {
      el.removeEventListener('scrollend', atRest)
      window.clearTimeout(timer)
      const wait = minDelayMs - (Date.now() - startedAt)
      if (wait > 0) timer = window.setTimeout(bump, wait)
      else bump()
    }
    fx.stopPing = () => {
      el.removeEventListener('scrollend', atRest)
      window.clearTimeout(timer)
      fx.stopPing = null
    }
    if (moving) {
      el.addEventListener('scrollend', atRest)
      timer = window.setTimeout(atRest, SCROLL_END_FALLBACK_MS)
    } else atRest()
  }, [])

  const applyView = useCallback(() => {
    const asked = pendingViewRef.current
    const el = scrollRef.current
    if (!asked || !el) return
    // A request made while no grid shows (the first load, an empty board) still
    // scrolls once one appears, but without the ping: the grid appears on a read,
    // and a ping then would play on its own, long after the press.
    const want =
      asked.pingAfterMs != null && !el.querySelector('[data-testid="board-calendar"]')
        ? { ...asked, pingAfterMs: undefined }
        : asked
    if (want !== asked) pendingViewRef.current = want
    const smooth = !!want.smooth && !prefersReducedMotion() && typeof el.scrollTo === 'function'
    const go = (top: number, left?: number) => {
      if (smooth) el.scrollTo({ top, ...(left != null ? { left } : {}), behavior: 'smooth' })
      else {
        el.scrollTop = top
        if (left != null) el.scrollLeft = left
      }
    }
    // `moving`: a smooth scroll is still on its way there.
    const done = (moving = false) => {
      pendingViewRef.current = null
      if (want.needsYou)
        el.querySelector<HTMLElement>('[data-testid="calendar-needs-you-today"]')?.focus({
          preventScroll: true,
        })
      if (want.pingAfterMs != null) pingToday(el, moving, want.pingAfterMs)
    }
    if (want.cardId) {
      const card = el.querySelector<HTMLElement>(
        `[data-focus-restore-id="${attrValue(want.cardId)}"]`,
      )
      if (!card) return
      card.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      if (want.flash) {
        card.focus({ preventScroll: true })
        flashCard(want.cardId)
      }
      done()
      return
    }
    if (want.day == null) {
      go(0, want.needsYou ? 0 : undefined)
      done()
      return
    }
    const row = el.querySelector<HTMLElement>(`[data-day-key="${dayKey(want.day)}"]`)
    if (!row) return
    const left = want.needsYou ? 0 : undefined
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    const visibleTop = el.scrollTop + HEADER_H
    const visibleBottom = el.scrollTop + el.clientHeight
    if (want.align === 'nearest' && top >= visibleTop && top + row.offsetHeight <= visibleBottom) {
      if (left != null) go(el.scrollTop, left)
      done()
      return
    }
    const target = Math.max(0, top - HEADER_H - 8)
    const moving = smooth && Math.abs(target - el.scrollTop) > 1
    go(target, left)
    // Landed (or will, once a smooth scroll ends), unless the grid is not yet tall
    // enough to scroll that far; then the next time it grows tries again.
    if (target <= el.scrollHeight - el.clientHeight + 1) done(moving)
    else if (want.pingAfterMs != null) {
      // The row cannot reach the top yet, but at the end of the scroll it is in
      // view: ping now, and keep steering without pinging again.
      pingToday(el, moving, want.pingAfterMs)
      pendingViewRef.current = { ...want, pingAfterMs: undefined }
    }
  }, [pingToday, flashCard])

  // Today (the button, T, or a toast's "Go to today") pings today's date once its
  // row is in view. A range that does not hold today slides in first, and the
  // ping waits for that. The All view has no today to ping.
  const goToday = useCallback(() => {
    const at = Date.now()
    const shown = rangeRef.current
    setFocusDay(startOfDay(at))
    requestView({
      day: at,
      align: 'top',
      smooth: true,
      pingAfterMs: shown && rangeContains(shown, at) ? 0 : RANGE_SLIDE_MS,
    })
  }, [requestView])

  const toastToday = useCallback(
    (message: string) =>
      addToast({
        message,
        type: 'info',
        ttlMs: 8000,
        action: { label: 'Go to today', onAction: goToday },
      }),
    [addToast, goToday],
  )

  const refresh = useCallback(async () => {
    // Claimed synchronously, before the await, so `handleCreated`'s optimistic
    // prepend and its reconcile read invalidate any in-flight read in the same tick.
    const read = reads.beginRead()
    setRefreshing(true)
    try {
      const res = await fetchBoardResult(teamFilter === 'all' ? undefined : teamFilter)
      // Superseded by a newer read, or by a local commit made after this read was
      // issued → a stale snapshot. Drop it rather than reverting newer state; the
      // next poll (≤5s) reconciles against a response that saw the commit.
      if (!read.isCurrent()) return
      if (res.ok) {
        noteArrivals(res.tasks, teamFilter)
        noteBoardRead(
          teamFilter,
          res.tasks.map((t) => ({ id: t.id, column: boardColumnOf(t), teamId: t.teamId })),
        )
        setTasks(res.tasks)
        setFetchOk(true)
        setReadAt(Date.now())
      } else if (!loadedRef.current) {
        // INITIAL load failed → show the error/retry screen.
        setTasks([])
        setFetchOk(false)
      }
      // A transient poll failure AFTER a good load keeps the last good snapshot:
      // don't blank a populated, actively-watched board to the error screen.
    } finally {
      // A `return` above still runs this, so the loading chrome needs its own guard:
      // an older read must neither clear the spinner while a newer read is still
      // running, nor dismiss the skeleton on a team-filter switch (which would flash
      // the previous team's tasks). `isNewestRead` (not `isCurrent`) on purpose, see
      // useReadSequencer. The newest read always resolves (`fetchBoardResult` never
      // throws), so `loaded` can't get stuck.
      if (read.isNewestRead()) {
        setRefreshing(false)
        setLoaded(true)
        loadedRef.current = true
      }
    }
  }, [teamFilter, reads, noteArrivals, noteBoardRead])

  useEffect(() => {
    setLoaded(false) // a team-filter change re-enters the loading state
    loadedRef.current = false
    void refresh()
  }, [refresh])

  useVisiblePolling(() => void refresh(), 5000)

  // "Open on board" from a chat task card: open that task's drawer. A filter set to
  // another team would hide the task's card behind the drawer, so it switches to
  // the task's team; "All teams" already shows the card and stays as it is. The
  // calendar then shows the card's day, so closing the drawer lands on the card.
  useEffect(() => {
    if (!boardFocus) return
    setTeamFilter((f) =>
      f !== 'all' && boardFocus.teamId && boardFocus.teamId !== f ? boardFocus.teamId : f,
    )
    setOpenTaskId(boardFocus.taskId)
    setRevealId(boardFocus.taskId)
    revealMissesRef.current = 0
    useViewStore.getState().clearBoardFocus()
  }, [boardFocus])

  // A manually-created task: show it instantly (optimistic prepend) unless the
  // active team filter would exclude it, then reconcile against the server. The
  // authoritative `refresh` corrects any drift (e.g. server-assigned fields).
  const handleCreated = useCallback(
    (task: BoardTask) => {
      markAction()
      const matchesFilter = teamFilter === 'all' || task.teamId === teamFilter
      // The person made it, so it is not news in any view, this one or its team's.
      absorbTask(task.id, boardColumnOf(task), task.teamId ?? null)
      if (matchesFilter) {
        reads.commitLocalWrite() // a read already in flight predates this prepend
        setTasks((prev) => (prev.some((t) => t.id === task.id) ? prev : [task, ...prev]))
        setLastTouchedId(task.id)
        settle(task.id)
        // A new task sits on today's row; say so when that row is not on screen.
        if (rangeRef.current && !todayVisibleRef.current) toastToday('It sits on today’s row.')
      }
      void refresh()
    },
    [teamFilter, refresh, reads, toastToday, markAction, settle, absorbTask],
  )

  // Tasks with any in-flight optimistic drag move applied, so the board (and the 5s
  // poll) keep the moved card in its target column until the server confirms. A move
  // that finishes the task also carries the moment it finished, so the calendar puts
  // the card on that day straight away.
  const effectiveTasks = useMemo(
    () =>
      Object.keys(overrides).length === 0
        ? tasks
        : tasks.map((t) => {
            const o = overrides[t.id]
            if (!o) return t
            return {
              ...t,
              status: o.status,
              ...(isFinishedStatus(o.status) ? { completedAt: o.at } : {}),
            }
          }),
    [tasks, overrides],
  )

  const activeTask = useMemo(
    () =>
      activeId == null
        ? null
        : (effectiveTasks.find((t) => t.id === activeId) ?? pickedRef.current),
    [activeId, effectiveTasks],
  )

  // Every task lands in exactly one column: Needs you when nothing will move it
  // on its own, else the column for its status (off-list statuses go to Other).
  const byColumn = useMemo(() => {
    const map: Record<string, BoardTask[]> = { [NEEDS_YOU_COLUMN]: [] }
    for (const col of COLUMNS) map[col.id] = []
    for (const t of effectiveTasks) (map[drawnColumnOf(t)] ??= []).push(t)
    return map
  }, [effectiveTasks])

  // Approvals and stuck tasks, gathered once for whichever layout is showing.
  const needsYou = useNeedsYou(teamFilter, byColumn[NEEDS_YOU_COLUMN] ?? [])

  // Append the catch-all "Other" column only when an off-list status appears.
  const columns = useMemo(
    () => (byColumn[OTHER_COLUMN.id]?.length ? [...COLUMNS, OTHER_COLUMN] : COLUMNS),
    [byColumn],
  )

  // ── Calendar projections ──
  const datedTasks = useMemo(
    () => effectiveTasks.filter((t) => drawnColumnOf(t) !== NEEDS_YOU_COLUMN),
    [effectiveTasks],
  )
  // The All view is the calendar with a single row, every task newest first.
  const buckets = useMemo(
    () =>
      range
        ? bucketTasks(datedTasks, range, now, drawnColumnOf)
        : bucketAll(datedTasks, now, drawnColumnOf),
    [range, datedTasks, now],
  )
  // A run whose time has passed has fired: it leaves the calendar, and the board
  // shows what it made. Runs are bucketed whether or not the Routines switch draws
  // them, because the switch shows their count while it hides them.
  const firedBefore = Math.max(now, readAt)
  const allRunsByDay = useMemo(
    () =>
      range
        ? bucketRuns(
            routines.map((r) => ({
              routine: r,
              windows: r.windows.map((w) => {
                const times = w.times.filter((t) => t > firedBefore)
                const fired = w.times.length - times.length
                return fired === 0 ? w : { ...w, times, count: Math.max(0, w.count - fired) }
              }),
            })),
            range,
          )
        : NO_RUNS,
    [range, routines, firedBefore],
  )
  // What the grid draws: nothing while the switch hides the runs.
  const runsByDay = prefs.showRoutines ? allRunsByDay : NO_RUNS
  // Counted over every run in the range, drawn or not, for the switch's count.
  const runStats = useMemo(() => {
    let count = 0
    let more = false
    let next: number | null = null
    for (const list of allRunsByDay.values()) {
      for (const r of list) {
        count += r.count
        more ||= r.more
        const first = r.times[0]
        if (first != null && first > now && (next == null || first < next)) next = first
      }
    }
    return { count, more, next }
  }, [allRunsByDay, now])
  // How many runs the grid draws.
  const drawnRuns = prefs.showRoutines ? runStats.count : 0
  // Open work from before the range matters while looking at now or ahead; a past
  // week is history and shows only its own days.
  const showEarlier = range != null && range.end > startOfDay(now)
  // Earlier opens when it holds work that is running or waiting to start, and
  // stays folded when everything in it is parked in Backlog; whatever the
  // person chooses holds for the rest of the session.
  const [earlierChoice, setEarlierChoice] = useState<boolean | null>(readEarlierChoice)
  const earlierHasLiveWork = useMemo(() => {
    for (const [col, list] of buckets.earlier) if (col !== 'backlog' && list.length > 0) return true
    return false
  }, [buckets])
  // The person's own move never folds the row out from under the card they moved:
  // once they act on an open row, it stays open for this range.
  const [earlierHeldFor, setEarlierHeldFor] = useState<string | null>(null)
  const earlierHeld = range != null && earlierHeldFor === rangeKeyOf(range)
  const earlierOpen = earlierChoice ?? (earlierHasLiveWork || earlierHeld)
  const earlierOpenRef = useRef(earlierOpen)
  earlierOpenRef.current = earlierOpen
  const holdEarlier = useCallback(() => {
    if (earlierOpenRef.current && rangeRef.current) {
      setEarlierHeldFor(rangeKeyOf(rangeRef.current))
    }
  }, [])
  const setEarlierOpen = useCallback((open: boolean) => {
    setEarlierChoice(open)
    writeEarlierChoice(open)
  }, [])
  // Every card on screen, the Earlier row's included, so the count matches the grid.
  const tasksInRange = useMemo(() => {
    let n = 0
    for (const byDay of buckets.cells.values()) for (const list of byDay.values()) n += list.length
    if (showEarlier) for (const list of buckets.earlier.values()) n += list.length
    return n
  }, [buckets, showEarlier])
  // The date picker dots the days that hold a card, which is where dated cards sit.
  const activeDays = useMemo(() => {
    const days = new Set<string>()
    for (const t of datedTasks) {
      const at = taskPlacedAt(t)
      if (at != null) days.add(dayKey(at))
    }
    return days
  }, [datedTasks])
  const pinnedIds = useMemo(
    () => new Set([openTaskId, lastTouchedId].filter((id): id is string => id != null)),
    [openTaskId, lastTouchedId],
  )
  // With no tasks, whether the board is empty depends on the routine runs, so the
  // first open waits for them rather than flashing a grid and then the empty state.
  // Once the calendar has shown, a new range keeps it up while its runs arrive.
  // Runs the switch hides draw nothing, so then there is nothing to wait for.
  const calendarSeenRef = useRef(false)
  const runsKnown = !prefs.showRoutines || runsSettled
  const waitingForRuns =
    range != null && tasks.length === 0 && !runsKnown && !calendarSeenRef.current
  // Nothing to show: no tasks at all, and no routine runs drawn in the range.
  const emptyBoard = tasks.length === 0 && drawnRuns === 0 && (range == null || runsKnown)
  const showCalendar = loaded && fetchOk && !emptyBoard && !waitingForRuns
  if (showCalendar) calendarSeenRef.current = true

  const onDragStart = useCallback(
    ({ active }: DragStartEvent) => {
      const picked = effectiveTasks.find((t) => t.id === active.id) ?? null
      pickedRef.current = picked
      setActiveId(picked ? picked.id : null)
      setDragOver(null)
      acknowledgeSeen([String(active.id)])
      // The lifted card is as wide as the card it came from. dnd-kit may not have
      // measured that card yet when this fires (and an event built by hand carries
      // no rect at all), so the card itself is the next place to look.
      const width =
        active.rect?.current?.initial?.width ??
        scrollRef.current
          ?.querySelector(
            `[data-testid="board-card"][data-focus-restore-id="${attrValue(String(active.id))}"]`,
          )
          ?.getBoundingClientRect().width
      setOverlayWidth(width && width > 0 ? width : OVERLAY_FALLBACK_W)
    },
    [effectiveTasks, acknowledgeSeen],
  )

  const onDragOver = useCallback(({ over }: DragOverEvent) => {
    setDragOver(over ? String(over.id) : null)
  }, [])

  // Resolve the drop to a status move and commit it through the SAME shared mutation
  // the drawer editor uses (legal-transition guard + agent-release confirm + rollback
  // + toast). The override only bridges the in-flight PATCH; on success the move is
  // committed into `tasks` and the override dropped, so the poll stays authoritative
  // (if the server later advances the task further, the next poll simply shows that).
  const clearOverride = useCallback(
    (taskId: string) =>
      setOverrides((o) => {
        if (!(taskId in o)) return o
        const n = { ...o }
        delete n[taskId]
        return n
      }),
    [],
  )

  // Commit a status change into the authoritative `tasks` so the card moves to its new
  // column at once, shared by the drawer's editor (via onStatusCommitted, issue #98) and
  // the drag commit below, so the two manual paths behave identically (the same optimistic
  // local-state patch handleCreated uses for a new card). Mirrors the server AND the
  // drawer's own setDetail: a →todo release also clears the assignee/runtime/verdict, so
  // the card never lingers with a stale runtime or a misleading verification pill until the
  // poll catches up, and a move to Done or Cancelled stamps the finish time the person
  // chose, so the calendar puts the card on that day. Drops any in-flight override for the
  // task so the committed status is authoritative; the next poll then simply agrees (same
  // id, one column): no flicker, no duplicate. It still re-sorts the row (the server bumps
  // `updatedAt`, which the board query orders by) and stays authoritative for any
  // concurrent agent change. The card settles where it lands, unless `settled` says
  // a drag already did that the moment the card was let go.
  //
  // One message says what happened and where the card went. When it went somewhere the
  // board isn't showing, the message carries the way there; when it is in the shown range,
  // the board scrolls it into view instead.
  const commitStatus = useCallback(
    (taskId: string, newStatus: string, commit?: StatusCommit, opts?: { settled?: boolean }) => {
      markAction()
      holdEarlier()
      // Fence off any read issued before this local write (the 5s poll, Refresh, a
      // reconcile) so a response that predates the change can't land and snap the card
      // back to its old column, the same guard handleCreated and the drag commit use.
      reads.commitLocalWrite()
      const now = Date.now()
      const at = commit?.completedAt ?? now
      const moved = tasksRef.current.find((t) => t.id === taskId)
      const unbound = moved ? unboundTodo(moved, newStatus) : false
      if (moved) {
        absorbTask(
          taskId,
          unbound
            ? NEEDS_YOU_COLUMN
            : boardColumnOf({ ...moved, status: newStatus, attention: undefined }),
          moved.teamId,
        )
      }
      const steps = new Set((commit?.cancelledDependents ?? []).map((d) => d.id))
      setTasks((prev) =>
        prev.map((t) => {
          if (steps.has(t.id)) {
            return { ...t, status: 'cancelled', attention: undefined, completedAt: now }
          }
          if (t.id !== taskId) return t
          return {
            ...t,
            status: newStatus,
            // The server's needs-you verdict was for the OLD status, so drop it and let
            // the next poll re-judge it. A To do with no agent bound is the one case
            // already known: it waits in Needs you for a person to pick an agent.
            attention: unbound ? { reason: 'unassigned', failedRuns: 0 } : undefined,
            ...(newStatus === 'todo'
              ? { assigneeAgentId: null, assigneeRuntime: null, verification: null }
              : {}),
            ...(isFinishedStatus(newStatus) ? { completedAt: at, runningSince: null } : {}),
          }
        }),
      )
      clearOverride(taskId)
      setLastTouchedId(taskId)
      if (!opts?.settled) settle(taskId)

      const shown = rangeRef.current
      const finished = isFinishedStatus(newStatus)
      // Finished work sits on the day it finished; anything else keeps its day, which
      // is on screen (the card was), except a To do with no agent, which joins
      // Needs you on today's row.
      const landsAt = finished || unbound ? at : null
      const inRange = shown == null || landsAt == null || rangeContains(shown, landsAt)
      // A card cancelled by hand goes where it can be seen, not into the folded rail,
      // when the board is showing the day it went to.
      if (newStatus === 'cancelled' && inRange && !prefsRef.current.cancelledOpen)
        updatePrefs({ cancelledOpen: true })

      const day = finished && !isSameDay(at, now) ? ` on ${shortDate(at)}` : ''
      const n = steps.size
      const chain =
        n > 0
          ? ` ${n === 1 ? 'One later step' : `${n} later steps`} waiting on it ${n === 1 ? 'was' : 'were'} cancelled too.`
          : ''
      const message =
        newStatus === 'done'
          ? `Marked done${day}.`
          : newStatus === 'cancelled'
            ? `Cancelled${day}.${chain}`
            : unbound
              ? 'Moved to To do. No agent is set to pick it up, so it waits in Needs you.'
              : `Moved to ${statusLabel(newStatus)}.`
      if (inRange) {
        addToast({ type: 'success', message })
        requestView({ day: null, align: 'nearest', cardId: taskId })
      } else {
        addToast({
          type: 'info',
          message,
          ttlMs: 8000,
          action: { label: 'Show', onAction: () => revealTask(taskId) },
        })
      }
    },
    [
      clearOverride,
      reads,
      updatePrefs,
      markAction,
      settle,
      absorbTask,
      holdEarlier,
      addToast,
      requestView,
      revealTask,
    ],
  )

  const onDragEnd = useCallback(
    async ({ active, over }: DragEndEvent) => {
      setActiveId(null)
      setDragOver(null)
      const move = resolveDrop(
        String(active.id),
        over ? String(over.id) : null,
        effectiveTasks,
        boardColumnOf,
      )
      if (!move) return
      // A read that lands while the move is in flight may already show it; it is
      // the person's move, not an agent's.
      markAction()
      holdEarlier()
      const task = effectiveTasks.find((t) => t.id === move.taskId)
      const commit = await mutate({
        taskId: move.taskId,
        from: move.from,
        to: move.to,
        assigneeAgentId: (task?.assigneeAgentId as string | null | undefined) ?? null,
        ...(task ? { task } : {}),
        weekStartsOn,
        // The board says where the card went (commitStatus).
        quiet: true,
        // The card settles in its new cell the moment it lands there, rather than
        // when the server answers.
        applyOptimistic: (completedAt) => {
          setOverrides((o) => ({
            ...o,
            [move.taskId]: { status: move.to, at: completedAt ?? Date.now() },
          }))
          settle(move.taskId)
        },
        rollback: () => clearOverride(move.taskId),
      })
      // The commit fences off any read issued before this point (via commitStatus →
      // reads.commitLocalWrite) so a pre-drag snapshot can't snap the card back, then
      // hands authority from the override back to `tasks`.
      if (commit) commitStatus(move.taskId, move.to, commit, { settled: true })
    },
    [
      effectiveTasks,
      mutate,
      clearOverride,
      commitStatus,
      markAction,
      settle,
      holdEarlier,
      weekStartsOn,
    ],
  )

  // Mid-drag, a card may only land on a column it can legally transition to; all other
  // columns are disabled as drop targets (so they neither highlight nor accept a drop).
  // In progress takes nothing from another column: a card is in progress because an
  // agent is running it, and a person moving it there would start no run, leaving a
  // card that looks worked on while nothing works on it.
  const columnDropDisabled = useCallback(
    (columnId: string) => {
      if (activeTask == null || boardColumnOf(activeTask) === columnId) return false
      if (columnId === 'in_progress') return true
      return !canTransition(activeTask.status, columnId)
    },
    [activeTask],
  )

  // Draggable only when the card has at least one legal target, so terminal
  // (done/cancelled) and off-list "Other" cards can't be dragged into illegal states.
  // Needs-you cards are moved with their own actions (Retry, Assign, Dismiss), not
  // by dragging: a stopped task is already `todo`, so a drop could not express
  // "run it again".
  const cardDisabled = useCallback((task: BoardTask) => statusOptions(task.status).length <= 1, [])

  // Where the card being dragged would land: its own row; today's row for a move
  // that finishes it (the default when a day is asked for); or today's Needs you
  // cell for a To do with no agent bound, which waits there for one.
  const landing = useMemo<Landing | null>(() => {
    if (!activeTask || !dragOver) return null
    if (dragOver === boardColumnOf(activeTask) || columnDropDisabled(dragOver)) return null
    const at = landingAnchor(activeTask, dragOver, now)
    if (unboundTodo(activeTask, dragOver)) {
      const rowKey = !range ? 'all' : rangeContains(range, now) ? dayKey(now) : null
      return { columnId: NEEDS_YOU_COLUMN, rowKey, caption: 'Needs an agent', at: now }
    }
    // The All view has one row, so a card lands in it whatever the move.
    if (!range) return { columnId: dragOver, rowKey: 'all', caption: 'Moves here', at }
    const rowKey =
      at < range.start
        ? showEarlier && !isFinishedStatus(dragOver)
          ? 'earlier'
          : null
        : at >= range.end
          ? null
          : dayKey(at)
    const picksDay = isFinishStatus(dragOver) && sitsOnOtherDay(activeTask, now) != null
    const caption =
      dragOver === 'done'
        ? picksDay
          ? 'Done, pick the day'
          : 'Done today'
        : dragOver === 'cancelled'
          ? picksDay
            ? 'Cancel, pick the day'
            : 'Cancelled today'
          : 'Moves here'
    return { columnId: dragOver, rowKey, caption, at }
  }, [range, activeTask, dragOver, columnDropDisabled, now, showEarlier])

  // One line under the lifted card when where it lands needs saying: a day to
  // pick, a landing row out of sight, or a card that keeps its day while the
  // pointer is over another one.
  const dragHint = useMemo<string | null>(() => {
    if (!range || !landing || !activeTask) return null
    if (landing.columnId === NEEDS_YOU_COLUMN) return 'No agent yet, so it waits in Needs you'
    if (isFinishedStatus(landing.columnId)) {
      if (sitsOnOtherDay(activeTask, now) != null) return 'You’ll pick the day next'
      return landing.rowKey === null || !visibility.today ? 'Lands on today’s row' : null
    }
    if (landing.rowKey === 'earlier') return 'Stays in Earlier'
    const at = landingAnchor(activeTask, landing.columnId, now)
    return isSameDay(at, now) ? null : `Stays on ${shortDate(at)}`
  }, [range, landing, activeTask, now, visibility.today])

  // How the lifted card leaves when it is let go. A drop that moves the card at
  // once needs no flight, since the card is already in its new cell; anything else
  // (no target, an illegal or its own column, or a move that asks first) flies it
  // back to its cell. dnd-kit reads this as the drag ends, by which point the drag
  // state here is cleared, so the answer worked out during the drag is kept.
  const dropAnimationRef = useRef<DropAnimation | null>(null)
  if (activeTask) {
    dropAnimationRef.current =
      prefersReducedMotion() || dropCommitsAtOnce(activeTask, dragOver, columnDropDisabled, now)
        ? null
        : DROP_RETURN
  }
  const dropAnimation = dropAnimationRef.current

  // ── Range navigation ──
  // Only a week and a month page; Today is today, and All has no dates.
  const pages = prefs.mode === 'week' || prefs.mode === 'month'
  const goPrev = useCallback(() => {
    const mode = prefs.mode
    if (mode === 'week' || mode === 'month') setFocusDay((f) => shiftFocus(mode, f, -1))
  }, [prefs.mode])
  const goNext = useCallback(() => {
    const mode = prefs.mode
    if (mode === 'week' || mode === 'month') setFocusDay((f) => shiftFocus(mode, f, 1))
  }, [prefs.mode])
  const setMode = useCallback((mode: CalendarMode) => updatePrefs({ mode }), [updatePrefs])

  // A range change is announced once, politely, with how many tasks the new range
  // shows (the Earlier row's included, as in the grid); polls that change counts
  // are not announced.
  const rangeKey = rangeKeyOf(range)
  const firstRange = useRef(true)
  useEffect(() => {
    if (firstRange.current) {
      firstRange.current = false
      return
    }
    if (!range) {
      setAnnouncement('All tasks, newest first.')
      return
    }
    const t = rangeTitle(range)
    const relation = rangeRelation(range, Date.now())
    const count = loadedRef.current ? ` ${countLabel(tasksInRange, 'task')}.` : ''
    setAnnouncement(
      `${relation ? `${relation}, ` : ''}${t.dates}${t.year ? ` ${t.year}` : ''}.${count}`,
    )
    // `range` and the count are read for the text only; `rangeKey` is what says it
    // changed, so a re-render with an equal range announces nothing.
  }, [rangeKey])

  // Paging slides the new range in from the side it came from. A new team filter
  // redraws the same range, so it only fades in.
  const gridKey = `${rangeKey}|${teamFilter}`
  const slideRef = useRef<{ key: string; rangeKey: string; start: number | null; dir: number }>({
    key: '',
    rangeKey: '',
    start: null,
    dir: 0,
  })
  if (slideRef.current.key !== gridKey) {
    const prev = slideRef.current
    slideRef.current = {
      key: gridKey,
      rangeKey,
      start: range?.start ?? null,
      dir:
        range && prev.start != null && prev.rangeKey !== rangeKey
          ? Math.sign(range.start - prev.start)
          : 0,
    }
  }
  const slideDir = slideRef.current.dir

  // Find opens from its button, or from / anywhere on the board.
  const openFind = useCallback((anchor?: HTMLElement) => {
    const el =
      anchor ?? rootRef.current?.querySelector<HTMLElement>('[data-testid="board-find"]') ?? null
    if (el) setFindAnchor(el)
  }, [])

  // Keyboard: T today, the arrows for the previous and next range, D W M A for
  // the views, / to find, while focus is on the board. Inert while typing, while any overlay is
  // open, and mid-drag. The arrows are left alone while focus is in the grid
  // itself, where they scroll it.
  const refocusViewRef = useRef(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keyBelongsElsewhere(e) || activeTask || hasOpenLayer()) return
      // Only while the board has focus, so the keys stay free everywhere else.
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) return
      if (useSettingsModalStore.getState().open || useEditorStore.getState().isOpen) return
      if (composerOpen || openTaskId || routineDialogId) return
      const k = e.key
      const arrow = k === 'ArrowLeft' || k === 'ArrowRight'
      if (arrow && e.target instanceof Node && scrollRef.current?.contains(e.target)) return
      // Escape puts out a picked date, and only then is it the board's key.
      if (k === 'Escape') {
        if (selectedDay == null) return
        setSelectedDay(null)
        e.preventDefault()
        return
      }
      if (k === '/') {
        e.preventDefault()
        openFind()
        return
      }
      let handled = true
      // All has no today row to go to.
      if ((k === 't' || k === 'T') && rangeRef.current) goToday()
      else if (k === 'ArrowLeft' && pages) goPrev()
      else if (k === 'ArrowRight' && pages) goNext()
      else if (k === 'd' || k === 'D') setMode('day')
      else if (k === 'w' || k === 'W') setMode('week')
      else if (k === 'm' || k === 'M') setMode('month')
      else if (k === 'a' || k === 'A') setMode('all')
      else handled = false
      if (handled) {
        e.preventDefault()
        refocusViewRef.current = true
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [
    activeTask,
    composerOpen,
    openTaskId,
    routineDialogId,
    pages,
    selectedDay,
    goToday,
    goPrev,
    goNext,
    setMode,
    openFind,
  ])
  // A shortcut can redraw the grid out from under the focused element; when it
  // does, focus goes to the view switch rather than being lost to the page.
  useEffect(() => {
    if (!refocusViewRef.current) return
    refocusViewRef.current = false
    const a = document.activeElement
    if (a && a !== document.body && a.isConnected) return
    document
      .querySelector<HTMLElement>(
        '[data-testid="board-calendar-toolbar"] [role="radio"][aria-checked="true"]',
      )
      ?.focus()
  }, [prefs.mode, rangeKey])

  // The calendar's min-height follows the board's visible area.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => el.style.setProperty('--board-vh', `${el.clientHeight}px`))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Track whether today's row and today's Needs you cell are on screen: the toolbar
  // offers a way back to Needs you when it is not, the Today button points the way
  // to today, and moves that put a card on today's row say so when that row is out
  // of sight. It also marks the scroll container once it has scrolled, which is
  // what gives the sticky header and day gutter their edge shadows.
  const checkVisibility = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.toggleAttribute('data-scrolled-y', el.scrollTop > 0)
    el.toggleAttribute('data-scrolled-x', el.scrollLeft > 0)
    const box = el.getBoundingClientRect()
    const laidOut = box.height > 0 && box.width > 0
    const calendar = el.querySelector('[data-testid="board-calendar"]') != null
    // On screen means enough of it shows to read: a sliver under the sticky
    // header or gutter does not count. Down the page that is a good part of a
    // row (a tall one can't fit whole); across, most of the column's width.
    const shown = (from: number, to: number, lo: number, hi: number, need: number) =>
      Math.min(to, hi) - Math.max(from, lo) >= need
    const inView = (node: Element | null, both: boolean): boolean => {
      if (!node) return false
      if (!laidOut) return true
      const r = node.getBoundingClientRect()
      const top = box.top + (calendar ? HEADER_H : 0)
      const onY = shown(r.top, r.bottom, top, box.bottom, Math.min(r.height, 120) * 0.6)
      if (!both) return onY
      const left = box.left + (calendar ? GUTTER_W : 0)
      return onY && shown(r.left, r.right, left, box.right, r.width * 0.6)
    }
    // The All view has no today row, so nothing there is out of sight of it.
    const shownRange = rangeRef.current
    const todayRow = calendar && shownRange ? el.querySelector('[data-today]') : null
    const today = calendar && shownRange ? inView(todayRow, false) : true
    // A range without today points the way out of it: earlier is to the left, as
    // the previous arrow is. A range holding today points up or down to its row,
    // by which side of the visible rows the row's middle falls on.
    const nowAt = Date.now()
    let direction: TodayDirection = null
    if (shownRange && !rangeContains(shownRange, nowAt)) {
      direction = shownRange.start > nowAt ? 'left' : 'right'
    } else if (shownRange && todayRow && !today) {
      const r = todayRow.getBoundingClientRect()
      const visibleMid = (box.top + HEADER_H + box.bottom) / 2
      direction = (r.top + r.bottom) / 2 < visibleMid ? 'up' : 'down'
    }
    setTodayDirection(direction)
    const ny = inView(
      el.querySelector(
        calendar
          ? '[data-testid="calendar-needs-you-today"]'
          : '[data-testid="board-column-needs-you"]',
      ),
      true,
    )
    todayVisibleRef.current = today
    setVisibility((v) => (v.today === today && v.needsYou === ny ? v : { today, needsYou: ny }))
    setMoreRight(laidOut && el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
  }, [])
  useEffect(() => {
    checkVisibility()
  })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', checkVisibility, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(checkVisibility)
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', checkVisibility)
      ro?.disconnect()
    }
  }, [checkVisibility])

  // Decide where to scroll on open, on a new range, and on a request. A new range
  // shows today when it holds today and starts at the top when it does not.
  useEffect(() => {
    if (viewRequest.n !== lastViewRequestRef.current) {
      lastViewRequestRef.current = viewRequest.n
      pendingViewRef.current = viewRequest.target
    } else {
      const want = pendingViewRef.current
      const fits =
        want != null &&
        (want.cardId != null ||
          want.day == null ||
          (range != null && rangeContains(range, want.day)))
      if (!fits) {
        pendingViewRef.current =
          range && rangeContains(range, Date.now())
            ? { day: Date.now(), align: range.mode === 'month' ? 'top' : 'nearest' }
            : { day: null, align: 'top' }
      }
    }
    applyView()
    // Keyed on the range (not the object), the first load and the grid appearing,
    // so a poll never pulls the board away while someone is reading another day.
  }, [viewRequest, rangeKey, loaded, showCalendar])

  useEffect(() => {
    const el = scrollRef.current
    const grid = el?.querySelector('[data-testid="board-calendar"]')
    if (!el || !grid || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (pendingViewRef.current) applyView()
    })
    ro.observe(grid)
    // A person scrolling takes over: stop steering the view.
    const stop = () => {
      pendingViewRef.current = null
    }
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('touchstart', stop, { passive: true })
    el.addEventListener('keydown', stop)
    el.addEventListener('pointerdown', stop)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', stop)
      el.removeEventListener('touchstart', stop)
      el.removeEventListener('keydown', stop)
      el.removeEventListener('pointerdown', stop)
    }
  }, [rangeKey, loaded, showCalendar, applyView])

  // "Open on board", Find and Show: once the board holds the task, show the day it
  // sits on (opening Cancelled or Earlier when it is there, and leaving Today for
  // its week when it is on another day), then bring its card into view. A task
  // the board never returns (another team, or gone) is given up on after a few
  // reads.
  useEffect(() => {
    if (!revealId || !loaded) return
    const task = effectiveTasks.find((t) => t.id === revealId)
    if (!task) {
      revealMissesRef.current += 1
      if (revealMissesRef.current > 2) setRevealId(null)
      return
    }
    setRevealId(null)
    const flash = revealFlashRef.current
    revealFlashRef.current = false
    const col = drawnColumnOf(task)
    if (col === 'cancelled' && !prefs.cancelledOpen) updatePrefs({ cancelledOpen: true })
    // Needs you lives in today's row, and its card may sit behind "+N more".
    const needsYouCard = col === NEEDS_YOU_COLUMN
    if (needsYouCard) setNeedsYouShow(task.id)
    const shown = rangeRef.current
    if (shown) {
      const at = Date.now()
      const day = needsYouCard ? at : taskAnchor(task, at)
      const inEarlier =
        !needsYouCard &&
        day < shown.start &&
        !isFinishedStatus(task.status) &&
        shown.end > startOfDay(at)
      if (inEarlier) {
        if (!earlierOpen) setEarlierOpen(true)
      } else if (!rangeContains(shown, day)) {
        if (shown.mode === 'day') updatePrefs({ mode: 'week' })
        setFocusDay(startOfDay(day))
      }
    }
    requestView({ day: null, align: 'nearest', cardId: task.id, flash })
    // Runs when the board's tasks change, so it sees each read.
  }, [revealId, loaded, effectiveTasks])

  // Resting on a card, or opening it, is looking at it.
  const seeCard = useCallback((taskId: string) => acknowledgeSeen([taskId]), [acknowledgeSeen])
  const openTask = useCallback(
    (taskId: string) => {
      setOpenTaskId(taskId)
      acknowledgeSeen([taskId])
    },
    [acknowledgeSeen],
  )

  // ── Routines opened from the calendar ──
  const routineReads = useReadSequencer()
  const loadRoutineRecords = useCallback(() => {
    const read = routineReads.beginRead()
    void fetchSchedules().then((v) => {
      if (read.isCurrent() && v.ok) setRoutineRecords(v.schedules)
    })
  }, [routineReads])
  // While a routine is open its record stays current, as it does in Routines.
  useVisiblePolling(loadRoutineRecords, 8000, { enabled: routineDialogId !== null })
  const openRoutine = useCallback(
    (run: RoutineOccurrences) => {
      setRunPopover(null)
      setRoutineRecords((prev) =>
        prev.some((r) => r.id === run.schedule.id) ? prev : [...prev, run.schedule],
      )
      setRoutineDialogId(run.schedule.id)
      void loadRoutineDirectory().then((d) => d && setDirectory(d))
      loadRoutineRecords()
    },
    [loadRoutineRecords],
  )
  const routineChanged = useCallback(() => {
    loadRoutineRecords()
    void refreshRuns()
    void refresh()
  }, [loadRoutineRecords, refreshRuns, refresh])
  const runNow = useCallback(
    async (run: RoutineOccurrences) => {
      const r = await runScheduleNow(run.schedule.id)
      if (r.ok) {
        addToast({ message: `Started “${routineName(run)}”`, type: 'success' })
        setRunPopover(null)
        void refreshRuns()
        void refresh()
      } else {
        addToast({ message: r.error ?? 'That did not start.', type: 'error' })
      }
    },
    [addToast, refreshRuns, refresh],
  )
  // A run that leaves the calendar (its routine paused elsewhere, say) takes its
  // popover with it, rather than leaving it pointing at nothing.
  useEffect(() => {
    if (runPopover && !runPopover.anchor.isConnected) setRunPopover(null)
  })

  const revealNeedsYou = useCallback(() => {
    // The All view keeps Needs you in its one row, at the top.
    if (!rangeRef.current) {
      requestView({ day: null, align: 'top', smooth: true, needsYou: true })
      return
    }
    setFocusDay(startOfDay(Date.now()))
    requestView({ day: Date.now(), align: 'nearest', smooth: true, needsYou: true })
  }, [requestView])

  // ── Since you last looked ──
  // Show steps through what changed, oldest first. Changes in Needs you are only
  // counted (it keeps its own list), so once only they are left, Show goes there.
  const showNextChange = useCallback(() => {
    const next = effectiveTasks
      .filter((t) => dotted.has(t.id))
      .sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0))[0]
    if (next) {
      acknowledgeSeen([next.id])
      revealTask(next.id)
      return
    }
    acknowledgeSeen(Object.keys(pendingSeen))
    revealNeedsYou()
  }, [effectiveTasks, dotted, pendingSeen, acknowledgeSeen, revealTask, revealNeedsYou])

  // The line holding "Mark seen" goes once everything is seen, so focus moves to
  // the date title (or Find, in All) rather than falling to the page.
  const markEverythingSeen = useCallback(() => {
    markAllSeen()
    setAnnouncement('Everything marked seen.')
    rootRef.current
      ?.querySelector<HTMLElement>('[data-testid="board-range-title"], [data-testid="board-find"]')
      ?.focus()
  }, [markAllSeen])

  // ── Find ──
  const closeFind = useCallback(() => {
    findAnchor?.focus()
    setFindAnchor(null)
  }, [findAnchor])
  // Read at search time rather than subscribed to, so agents streaming work do
  // not re-render the board.
  const agentName = useCallback(
    (agentId: string) =>
      useFleetStore.getState().agents.find((a) => a.id === agentId)?.name ?? null,
    [],
  )
  const searchBoard = useCallback(
    (query: string) =>
      matchBoard(query, {
        tasks: effectiveTasks,
        columnOf: drawnColumnOf,
        ownerOf: taskOwnerOf,
        agentName,
        routines,
        routineName,
        range,
        showEarlier,
        now,
      }),
    [effectiveTasks, agentName, routines, range, showEarlier, now],
  )
  const pickFound = useCallback(
    (found: FindResult, how: 'reveal' | 'open') => {
      setFindAnchor(null)
      if (found.kind === 'routine') {
        openRoutine(found.routine)
        return
      }
      revealTask(found.id, how === 'reveal')
      if (how === 'open') openTask(found.id)
    },
    [openRoutine, revealTask, openTask],
  )
  const findDayLabel = useCallback(
    (at: number | null) => (at == null ? '' : (relativeDayWord(at, now) ?? dayMonth(at))),
    [now],
  )

  // The drawer and Needs you's actions (Retry, Assign, Dismiss) report a change
  // the person made.
  const onTasksChanged = useCallback(() => {
    markAction()
    void refresh()
  }, [refresh, markAction])

  // The run strip whose popover is open, by the id the strip carries for focus.
  const openRunKey = runPopover?.anchor.getAttribute('data-focus-restore-id') ?? null

  return (
    <div ref={rootRef} className="board-ink-focus flex h-full flex-col">
      <PanelHeader
        title="Board"
        // The board is a live projection of agent work, so without a word a person
        // may wait to be asked before touching it. This says who moves the cards and
        // that they may hand one out too (the New task button beside it).
        subtitle={
          // Back from being away, the line says what changed meanwhile, and steps
          // through it. Otherwise it says who moves the cards.
          seenSum ? (
            <span data-testid="board-since" className="inline-flex max-w-full items-baseline gap-2">
              <span className="truncate">
                {`Since ${sinceLabel(seenSum.since, now)}: ${summaryParts(seenSum.counts).join(', ')}`}
              </span>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={showNextChange}
                title="Show the oldest change you have not looked at"
                className={SINCE_ACTION}
              >
                Show
              </button>
              <span aria-hidden>·</span>
              <button type="button" onClick={markEverythingSeen} className={SINCE_ACTION}>
                Mark seen
              </button>
            </span>
          ) : (
            <span data-testid="board-agent-hint">
              Agents create and move work here. You can hand one a task too.
            </span>
          )
        }
        icon={KanbanSquare}
        size="md"
        border
        actions={
          <>
            <Select
              size="sm"
              aria-label="Filter by team"
              value={teamFilter}
              onChange={(value) => setTeamFilter(value)}
            >
              <option value="all">All teams</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.icon} {t.name}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void refresh()
                void refreshRuns()
              }}
              aria-label="Refresh"
            >
              {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} strokeWidth={2} />}
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => setComposerOpen(true)}>
              <Plus size={14} strokeWidth={2.4} />
              New task
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <CalendarToolbar
        mode={prefs.mode}
        onModeChange={setMode}
        range={range}
        now={now}
        weekStartsOn={weekStartsOn}
        activeDays={activeDays}
        onPrev={goPrev}
        onNext={goNext}
        onToday={goToday}
        onPickDate={(day) => {
          // Today shows only today, so a picked date opens its week.
          if (prefs.mode === 'day') updatePrefs({ mode: 'week' })
          setFocusDay(startOfDay(day))
          setSelectedDay(startOfDay(day))
          requestView({ day, align: 'top' })
        }}
        summary={{ tasks: tasksInRange, runs: runStats.count, runsMore: runStats.more }}
        showRoutines={prefs.showRoutines}
        onShowRoutinesChange={(showRoutines) => updatePrefs({ showRoutines })}
        needsYou={{
          count: needsYou.total,
          offscreen: !visibility.needsYou,
          onReveal: revealNeedsYou,
        }}
        announcement={announcement}
        todayDirection={todayDirection}
        onFind={(anchor) => (findAnchor ? closeFind() : openFind(anchor))}
        findOpen={findAnchor != null}
      />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          // The calendar runs edge to edge: its date gutter sticks to the left edge,
          // and side padding would leave a strip beside it where scrolled cells show.
          // The scroll padding keeps a card brought into view clear of the sticky
          // header and gutter.
          className={[
            'relative min-h-0 flex-1 overflow-auto',
            showCalendar ? '' : 'px-6 py-5',
          ].join(' ')}
          style={
            showCalendar
              ? {
                  paddingBottom: BOTTOM_PAD,
                  scrollPaddingTop: HEADER_H + 8,
                  scrollPaddingLeft: GUTTER_W + 8,
                }
              : undefined
          }
        >
          <DndContext
            sensors={sensors}
            collisionDetection={boardCollision}
            // Replaces dnd-kit's defaults, which announce raw task uuids and raw
            // status ids. Module constants → stable identity → the internal
            // useDndMonitor never re-registers.
            accessibility={range ? CALENDAR_ACCESSIBILITY : BOARD_ACCESSIBILITY}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
              // A cancel never moves the card, so it always flies back. dnd-kit
              // clears the drag without a last drag-over first, and the render that
              // ends the drag (the one the overlay reads) keeps what is set here.
              dropAnimationRef.current = prefersReducedMotion() ? null : DROP_RETURN
              setActiveId(null)
              setDragOver(null)
            }}
          >
            {showCalendar ? (
              <motion.div
                key={gridKey}
                initial={{ opacity: 0, x: slideDir * 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: RANGE_SLIDE_MS / 1000, ease: [0.32, 0.72, 0, 1] }}
              >
                <CalendarGrid
                  range={range}
                  now={now}
                  weekStartsOn={weekStartsOn}
                  weekend={weekend}
                  selectedDay={selectedDay}
                  onSelectDay={setSelectedDay}
                  columns={columns}
                  buckets={buckets}
                  runsByDay={runsByDay}
                  nextRunAt={
                    prefs.showRoutines && range && rangeContains(range, now) ? runStats.next : null
                  }
                  showEarlier={showEarlier}
                  earlierOpen={earlierOpen}
                  onEarlierOpenChange={setEarlierOpen}
                  needsYou={{
                    total: needsYou.total,
                    content: (
                      <NeedsYouItems
                        model={needsYou}
                        teamFilter={teamFilter}
                        onOpenTask={openTask}
                        onTasksChanged={onTasksChanged}
                        layout="cell"
                        // Today and All show every card in a cell, Needs you too.
                        cap={range && range.mode !== 'day' ? NEEDS_YOU_CAP : undefined}
                        show={needsYouShow}
                      />
                    ),
                    onGoToday: revealNeedsYou,
                  }}
                  cancelledOpen={prefs.cancelledOpen}
                  onCancelledOpenChange={(cancelledOpen) => updatePrefs({ cancelledOpen })}
                  pinnedIds={pinnedIds}
                  drag={
                    activeTask
                      ? {
                          task: activeTask,
                          ownColumn: boardColumnOf(activeTask),
                          overColumn: dragOver,
                        }
                      : null
                  }
                  landing={landing}
                  columnDropDisabled={columnDropDisabled}
                  cardDisabled={cardDisabled}
                  onCardOpen={openTask}
                  onRunOpen={(run, anchor) => setRunPopover({ run, anchor })}
                  openTaskId={openTaskId}
                  openRunKey={openRunKey}
                  arrivedIds={arrivedIds}
                  settleId={settleId}
                  todayPing={todayPing}
                  unseenIds={dotted}
                  onSeen={seeCard}
                />
              </motion.div>
            ) : (
              <div className="flex min-h-full items-start gap-4">
                {/* Needs you ALWAYS renders as the first column, outside the task-load
                branch: its approvals are decoupled from the board-task fetch (an exec
                store + a /api/tools/approvals poll), so a /api/board outage never hides
                a pending, time-sensitive gate. Its tasks are the ones nothing will move
                on its own (failed, timed out, stopped, blocked, unassigned). Scoped to
                the team filter and always expanded, like every other column. */}
                <NeedsYouLane
                  model={needsYou}
                  teamFilter={teamFilter}
                  onOpenTask={openTask}
                  onTasksChanged={onTasksChanged}
                />
                {!loaded || waitingForRuns ? (
                  // Skeleton columns until the first fetch resolves (mirrors the
                  // RuntimesPanel `!loaded` pattern: empty columns shouldn't flash first),
                  // as wide as the calendar's so the board does not jump when it lands.
                  <div
                    data-testid="board-skeleton"
                    style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}
                  >
                    {COLUMNS.map((col) => (
                      <div
                        key={col.id}
                        style={{
                          flex: '0 0 184px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                        }}
                      >
                        <Skeleton width="50%" height={11} />
                        <Skeleton height={72} radius={16} />
                        <Skeleton height={72} radius={16} />
                      </div>
                    ))}
                  </div>
                ) : !fetchOk ? (
                  // The fetch FAILED, said as such: an empty board has its own empty
                  // state, and showing that here would hide the error.
                  <div data-testid="board-fetch-error" className="max-w-[460px]">
                    <FormattedAlert tone="error">
                      <span className="flex items-center gap-2">
                        Couldn’t load the board.
                        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                          Retry
                        </Button>
                      </span>
                    </FormattedAlert>
                  </div>
                ) : emptyBoard ? (
                  // A genuinely empty board (fetch OK, zero tasks, no routine runs ahead)
                  // → one board-level empty state with a manual CTA, rather than a grid of
                  // empty cells. Reinforces the agent-driven model and offers the manual
                  // escape hatch in the same place a first-time user looks.
                  <div
                    data-testid="board-empty"
                    className="flex flex-1 items-center justify-center py-16"
                  >
                    <EmptyState
                      // A calm Boo in To do's blue, where a first task lands. Amber
                      // is Needs you's and red is today's, so neither is left to
                      // the seed.
                      art={
                        <BooAvatar
                          seed="clawboo-board-empty"
                          size={56}
                          tint={TINTS[3]}
                          eyeShape={0}
                          accessory="none"
                        />
                      }
                      title="No tasks yet"
                      helper="Agents populate this board automatically as work is delegated in chat. You can also add the first task yourself."
                      action={
                        <Button variant="primary" size="sm" onClick={() => setComposerOpen(true)}>
                          <Plus size={14} strokeWidth={2.4} /> New task
                        </Button>
                      }
                    />
                  </div>
                ) : null}
              </div>
            )}
            {/* Rendered in an overlay so the moving card isn't clipped by column
              overflow, and follows the pointer/keyboard cursor across columns. */}
            <DragOverlay dropAnimation={dropAnimation}>
              {activeTask ? (
                <div className="cursor-grabbing" style={{ width: overlayWidth }}>
                  <TaskCard
                    task={activeTask}
                    onClick={() => {}}
                    // The lifted card keeps the stamp it had in its cell: a date when
                    // it came from the Earlier row.
                    stamp={calendarStamp(
                      activeTask,
                      !range
                        ? 'all'
                        : showEarlier &&
                            !isFinishedStatus(activeTask.status) &&
                            taskAnchor(activeTask, now) < range.start
                          ? 'earlier'
                          : 'day',
                      now,
                    )}
                    accent={columnHue(boardColumnOf(activeTask))}
                    lifted
                  />
                  {dragHint ? (
                    <div
                      data-testid="board-drag-hint"
                      className="mt-1.5 inline-flex rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-foreground shadow-[var(--shadow-raised)]"
                    >
                      {dragHint}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
        {showCalendar && moreRight ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-12"
            style={{
              background: 'linear-gradient(to right, transparent, var(--surface))',
            }}
          />
        ) : null}
      </div>

      <AnimatePresence
        // Closing the drawer hands focus back to the card that opened it. When the
        // card's new home is off screen (today's row, from another week), focus
        // goes to Today rather than being lost to the page.
        onExitComplete={() => {
          const a = document.activeElement
          if (a && a !== document.body && a.isConnected) return
          document
            .querySelector<HTMLElement>('[data-testid="board-calendar-toolbar"] button')
            ?.focus()
        }}
      >
        {openTaskId && (
          <TaskDetailDrawer
            taskId={openTaskId}
            onClose={() => setOpenTaskId(null)}
            onStatusCommitted={commitStatus}
            onChanged={onTasksChanged}
          />
        )}
      </AnimatePresence>

      {runPopover ? (
        <RoutineRunPopover
          run={runPopover.run}
          anchor={runPopover.anchor}
          now={now}
          timeZone={timeZone}
          onClose={() => setRunPopover(null)}
          onRunNow={() => runNow(runPopover.run)}
          onOpenRoutine={() => openRoutine(runPopover.run)}
        />
      ) : null}

      {findAnchor ? (
        <FindPopover
          anchor={findAnchor}
          search={searchBoard}
          scope={range ? range.mode : 'all'}
          findsRoutines={range != null}
          hueOf={(column) => (column === NEEDS_YOU_COLUMN ? 'var(--amber)' : columnHue(column))}
          columnName={(column) => (column === NEEDS_YOU_COLUMN ? 'Needs you' : statusLabel(column))}
          dayLabel={findDayLabel}
          ownerOf={taskOwnerOf}
          agentName={agentName}
          onPick={pickFound}
          onClose={closeFind}
        />
      ) : null}

      {routineDialogId ? (
        <RoutineDialog
          key={routineDialogId}
          target={{ mode: 'view', id: routineDialogId }}
          record={routineRecords.find((r) => r.id === routineDialogId) ?? null}
          directory={directory}
          preferredTeamId={teamFilter !== 'all' ? teamFilter : null}
          onClose={() => setRoutineDialogId(null)}
          onChanged={routineChanged}
          onOpenTask={(taskId) => {
            setRoutineDialogId(null)
            openTask(taskId)
          }}
        />
      ) : null}

      <NewTaskDialog
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        defaultTeamId={teamFilter !== 'all' ? teamFilter : undefined}
        onCreated={handleCreated}
      />
    </div>
  )
}
