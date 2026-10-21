// The Board's calendar model: which days a view shows, which day each task sits
// on, and which day each upcoming routine run lands on. Pure and DOM-free, so the
// node test project covers it without rendering anything.
//
// Placement rule, in one sentence: open work sits on the day it was added,
// finished work on the day it finished, and a routine's upcoming runs on the
// days they are scheduled. A card therefore stays in its row while it moves
// across the status columns, and only Done and Cancelled carry it to the day it
// ended. Open work added before the range is collected in an "Earlier" row, so
// changing the range never hides something that is still in play.
//
// Days are LOCAL calendar days. Every step goes through `Date#setDate` and
// `setHours(0, 0, 0, 0)`, never `+ 24h`, so a day that is 23 or 25 hours long
// (a daylight-saving change) still starts and ends at midnight.

import type { WindowOccurrences } from '@clawboo/scheduler'

export type CalendarMode = 'day' | 'week' | 'month' | 'all'

/** The views that show days: everything but the undated All view. */
export type RangeMode = Exclude<CalendarMode, 'all'>

export interface CalendarRange {
  mode: RangeMode
  /** Local midnight of every day shown, ascending. */
  days: number[]
  /** The first instant shown (`days[0]`). */
  start: number
  /** The first instant after the range: the midnight that ends its last day. */
  end: number
}

/** Local midnight of the day holding `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The start of the local day `n` calendar days after the day holding `ms`.
 *  Normally midnight; where a daylight-saving change skips midnight, the
 *  first instant that day has. */
export function addDays(ms: number, n: number): number {
  const d = new Date(startOfDay(ms))
  d.setDate(d.getDate() + n)
  // A day whose midnight was skipped started later, and stepping from it would
  // carry that offset into the next day; resetting lands on that day's start.
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** A stable key for the local day holding `ms`: `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

// Where an engine has no Intl week info (Firefox), the region decides: CLDR's
// lists of regions whose week starts on Sunday or Saturday. Everywhere else
// starts on Monday, the ISO 8601 default.
const SUNDAY_FIRST = new Set(
  (
    'AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT ' +
    'MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'
  ).split(' '),
)
const SATURDAY_FIRST = new Set('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '))

/**
 * The weekday a week starts on for `locale`, in `Date#getDay` numbering (0 is
 * Sunday). Reads `Intl.Locale` week info where the engine has it, else the
 * locale's region, else Monday.
 */
export function localeWeekStart(locale?: string): number {
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined)
    if (!tag) return 1
    const loc = new Intl.Locale(tag) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number }
      weekInfo?: { firstDay?: number }
    }
    const firstDay = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay
    // Intl numbers weekdays 1 (Monday) to 7 (Sunday).
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) return firstDay % 7
    const region = loc.maximize().region
    if (region && SUNDAY_FIRST.has(region)) return 0
    if (region && SATURDAY_FIRST.has(region)) return 6
  } catch {
    // An unknown tag, or an engine without Intl.Locale.
  }
  return 1
}

/**
 * The weekend for `locale`, in `Date#getDay` numbering. Reads `Intl.Locale` week
 * info where the engine has it; elsewhere Saturday and Sunday, which is right
 * for most regions and only ever shades two rows.
 */
export function localeWeekend(locale?: string): ReadonlySet<number> {
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined)
    if (tag) {
      const loc = new Intl.Locale(tag) as Intl.Locale & {
        getWeekInfo?: () => { weekend?: number[] }
        weekInfo?: { weekend?: number[] }
      }
      const weekend = loc.getWeekInfo?.().weekend ?? loc.weekInfo?.weekend
      if (Array.isArray(weekend) && weekend.length > 0 && weekend.every((d) => d >= 1 && d <= 7))
        return new Set(weekend.map((d) => d % 7))
    }
  } catch {
    // An unknown tag, or an engine without Intl.Locale.
  }
  return new Set([6, 0])
}

/**
 * The items a capped cell shows, in their own order: the newest ones, plus any
 * that must stay in sight (the task open in the drawer, the one just added or
 * moved) even when they are older. Every pinned item counts toward the cap.
 */
export function pickShown<T extends { id: string }>(
  items: readonly T[],
  cap: number,
  pinned: ReadonlySet<string>,
): T[] {
  if (items.length <= cap) return [...items]
  const keep = new Set<string>()
  for (const it of items) if (pinned.has(it.id)) keep.add(it.id)
  for (let i = items.length - 1; i >= 0 && keep.size < cap; i--) keep.add(items[i]!.id)
  return items.filter((it) => keep.has(it.id))
}

/** Local midnight of the first day of the week holding `ms`. */
export function startOfWeek(ms: number, weekStartsOn: number): number {
  const d = new Date(startOfDay(ms))
  const back = (d.getDay() - weekStartsOn + 7) % 7
  d.setDate(d.getDate() - back)
  return d.getTime()
}

/** Local midnight of the first day of the month holding `ms`. */
export function startOfMonth(ms: number): number {
  const d = new Date(startOfDay(ms))
  d.setDate(1)
  return d.getTime()
}

/** The days a day, week or month view shows around `focus`. */
export function buildRange(mode: RangeMode, focus: number, weekStartsOn: number): CalendarRange {
  if (mode === 'day') {
    const day = startOfDay(focus)
    return { mode, days: [day], start: day, end: addDays(day, 1) }
  }
  const first = mode === 'week' ? startOfWeek(focus, weekStartsOn) : startOfMonth(focus)
  const days: number[] = []
  if (mode === 'week') {
    for (let i = 0; i < 7; i++) days.push(addDays(first, i))
  } else {
    const month = new Date(first).getMonth()
    for (let t = first; new Date(t).getMonth() === month; t = addDays(t, 1)) days.push(t)
  }
  return { mode, days, start: first, end: addDays(days[days.length - 1]!, 1) }
}

/** The focus date one day, week or month before (`delta` -1) or after (+1). */
export function shiftFocus(mode: RangeMode, focus: number, delta: number): number {
  if (mode === 'day') return addDays(focus, delta)
  if (mode === 'week') return addDays(focus, 7 * delta)
  const d = new Date(startOfMonth(focus))
  d.setMonth(d.getMonth() + delta)
  return d.getTime()
}

/** The window edges to ask the server for: every day's midnight, plus the end. */
export function rangeBounds(range: CalendarRange): number[] {
  return [...range.days, range.end]
}

export function rangeContains(range: CalendarRange, ms: number): boolean {
  return ms >= range.start && ms < range.end
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

/** The task fields placement reads. Timestamps arrive from the API untyped. */
export interface PlaceableTask {
  status: string
  createdAt?: unknown
  updatedAt?: unknown
  completedAt?: unknown
}

const FINISHED = new Set(['done', 'cancelled'])

export function isFinishedStatus(status: string): boolean {
  return FINISHED.has(status)
}

function epoch(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * The instant that decides a task's day: when it finished, for Done and
 * Cancelled, else when it was added. Null when the row carries no usable
 * timestamp.
 */
export function taskPlacedAt(task: PlaceableTask): number | null {
  if (isFinishedStatus(task.status)) {
    return epoch(task.completedAt) ?? epoch(task.updatedAt) ?? epoch(task.createdAt)
  }
  return epoch(task.createdAt) ?? epoch(task.updatedAt)
}

/** `taskPlacedAt`, falling back to `now` so a row with no timestamps shows on
 *  today rather than nowhere. */
export function taskAnchor(task: PlaceableTask, now: number): number {
  return taskPlacedAt(task) ?? now
}

export interface TaskBuckets<T> {
  /** Column id, then day key, to that cell's tasks in time order. */
  cells: Map<string, Map<string, T[]>>
  /** Column id to open tasks added before the range, oldest first. */
  earlier: Map<string, T[]>
}

/**
 * Sort tasks into the range's day cells. A finished task outside the range is
 * history the view does not show; an open one added before the range goes to
 * Earlier. Anything placed after the range (a later week, or a clock ahead of
 * this one) belongs to a later view.
 */
export function bucketTasks<T extends PlaceableTask>(
  tasks: readonly T[],
  range: CalendarRange,
  now: number,
  columnOf: (task: T) => string,
): TaskBuckets<T> {
  const placed: Array<{ task: T; col: string; at: number }> = []
  for (const task of tasks) placed.push({ task, col: columnOf(task), at: taskAnchor(task, now) })
  placed.sort((a, b) => a.at - b.at)

  const cells = new Map<string, Map<string, T[]>>()
  const earlier = new Map<string, T[]>()
  for (const { task, col, at } of placed) {
    if (at >= range.end) continue
    if (at < range.start) {
      if (isFinishedStatus(task.status)) continue
      const list = earlier.get(col)
      if (list) list.push(task)
      else earlier.set(col, [task])
      continue
    }
    let byDay = cells.get(col)
    if (!byDay) cells.set(col, (byDay = new Map()))
    const key = dayKey(at)
    const list = byDay.get(key)
    if (list) list.push(task)
    else byDay.set(key, [task])
  }
  return { cells, earlier }
}

/** The All view's one row, as a cell key. */
export const ALL_ROW = 'all'

/**
 * Every task in one row, by column, newest first: what the All view draws. It
 * shares the calendar's buckets, with the single row keyed `ALL_ROW`.
 */
export function bucketAll<T extends PlaceableTask>(
  tasks: readonly T[],
  now: number,
  columnOf: (task: T) => string,
): TaskBuckets<T> {
  const placed = tasks.map((task) => ({ task, col: columnOf(task), at: taskAnchor(task, now) }))
  placed.sort((a, b) => b.at - a.at)
  const cells = new Map<string, Map<string, T[]>>()
  for (const { task, col } of placed) {
    let byRow = cells.get(col)
    if (!byRow) cells.set(col, (byRow = new Map([[ALL_ROW, []]])))
    byRow.get(ALL_ROW)!.push(task)
  }
  return { cells, earlier: new Map() }
}

/**
 * The day a card lands on when a person moves it to `toStatus` right now:
 * today when the move finishes it, else the day it already sits on.
 */
export function landingAnchor(task: PlaceableTask, toStatus: string, now: number): number {
  return isFinishedStatus(toStatus) ? now : taskAnchor({ ...task, status: toStatus }, now)
}

// ─── Routine runs ───────────────────────────────────────────────────────────

/** One routine's runs on one day, as the To do column draws them. */
export interface DayRuns<R> {
  routine: R
  /** Runs that day, counted up to the server's cap. */
  count: number
  /** True when the day holds more runs than `count`. */
  more: boolean
  /** The day's earliest run times, ascending. */
  times: number[]
}

/**
 * Index server-projected runs by day. `windows` must line up with
 * `rangeBounds(range)`, one entry per day; a routine whose windows do not (the
 * response to an older range) is skipped rather than drawn on the wrong days.
 */
export function bucketRuns<R>(
  routines: ReadonlyArray<{ routine: R; windows: readonly WindowOccurrences[] }>,
  range: CalendarRange,
): Map<string, DayRuns<R>[]> {
  const byDay = new Map<string, DayRuns<R>[]>()
  for (const { routine, windows } of routines) {
    if (windows.length !== range.days.length) continue
    windows.forEach((w, i) => {
      if (w.count <= 0) return
      const key = dayKey(range.days[i]!)
      const entry: DayRuns<R> = { routine, count: w.count, more: w.more, times: [...w.times] }
      const list = byDay.get(key)
      if (list) list.push(entry)
      else byDay.set(key, [entry])
    })
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.times[0] ?? Infinity) - (b.times[0] ?? Infinity))
  }
  return byDay
}
