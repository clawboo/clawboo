// The Board as a calendar: status columns across the top, days down the side,
// every card in one cell. One CSS grid holds it all. Each column spans every row
// and lays its cells on the parent's rows through `subgrid`, so a column stays a
// single element (one drop target, one labelled group) while its cells line up
// with the day gutter on the left. Rows size to their content. A run of quiet
// days folds into a seam, one line that opens where it is clicked; Earlier, the
// row of open work from before the range, folds when all of it is parked.
//
// It is a kanban first. Each column is a neutral lane that runs unbroken from
// top to bottom, with space rather than rules between lanes; a day is a hairline
// step inside them, so the eye follows work down a column rather than across a
// row. The only colour in a column is the small status glyph in its title. A
// card is a plain card, and an upcoming routine run is a dashed outline of one.
// The day gutter carries the calendar: today's date is the one red circle on the
// board, and a row lights up only when someone picks its date.
//
// Needs you is the first column, and it only has today: what is waiting on a
// person is waiting now, so it sits in today's row (in the All view, in its one
// row). Looking at a range without today folds it to a rail that leads back.

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react'
import { useDroppable } from '@dnd-kit/core'
import { ChevronDown, ChevronRight, EyeOff, FoldVertical, Plus, UnfoldVertical } from 'lucide-react'

import type { BoardTask } from '@/lib/boardClient'
import type { RoutineOccurrences } from '@/lib/schedulesClient'

import { NEEDS_YOU_COLUMN } from '../boardStatus'
import { StatusGlyph, glyphKindOf } from '../StatusGlyph'
import { DraggableCard, type CardStamp } from '../TaskCard'
import {
  agoLabel,
  countLabel,
  dayMonth,
  elapsedLabel,
  isoWeek,
  longDate,
  monthShort,
  relativeDayWord,
  shortDate,
  timeLabel,
  timeOnDay,
  weekdayShort,
} from './calendarFormat'
import {
  addDays,
  dayKey,
  isFinishedStatus,
  isSameDay,
  pickShown,
  startOfDay,
  taskAnchor,
  taskPlacedAt,
  type CalendarRange,
  type DayRuns,
  type TaskBuckets,
} from './calendarModel'
import { RoutineRunStrip } from './RoutineRun'

// The widths and the space between lanes add up to 1136px with Cancelled
// folded, which fits the board's share of a 1440px screen beside the app's
// sidebars: every column on screen, no sideways scroll. The gutter is a date and
// a weekday, like a calendar's.
export const GUTTER_W = 64
export const NEEDS_YOU_W = 248
export const HEADER_H = 44
/** The space the board leaves under the grid (its scroll container's bottom padding). */
export const BOTTOM_PAD = 32
/** The narrowest a status column gets; wider screens share out the rest. */
export const COLUMN_MIN = 184
/** Space between lanes: spacing separates them, not rules. */
export const LANE_GAP = 8
export const LANE_RADIUS = 12
/** The Kanban board's side gutter, the same as the bars above it. */
export const KANBAN_PAD = 16
/** Cards a cell of the Earlier row shows before "+N more", in every view. */
const EARLIER_CAP = 3
export const RAIL_W = 40
const RUN_CAP = 2
/** A seam's height: folded quiet days are a line, not a row. */
const SEAM_H = 12
/** Earlier's summary reads from the furthest along: running, then to do, then
 *  parked in Backlog. */
const EARLIER_ORDER = ['in_progress', 'todo', 'backlog']
const EARLIER_WORD: Record<string, string> = {
  in_progress: 'running',
  todo: 'to do',
  backlog: 'parked',
}
/** Needs you items today's cell shows before "+N more". */
export const NEEDS_YOU_CAP = 3

/** What an empty lane on the Kanban board says, in its column's words. */
const EMPTY_LANE: Record<string, string> = {
  backlog: 'Nothing parked',
  todo: 'Nothing waiting to start',
  in_progress: 'Nothing running',
  done: 'Nothing finished yet',
  cancelled: 'Nothing cancelled',
}

/** How far a column that cannot take the dragged card steps back. */
const DIM_WHILE_DRAGGING = 0.45

// Every lane is the same faint neutral. A lane under a dragged card that can
// land there fills a step more. Cells paint `--lane`, so the column sets it once.
export const LANE = 'rgb(var(--foreground-rgb) / 0.025)'
const LANE_OVER = 'rgb(var(--foreground-rgb) / 0.06)'

export interface CalendarColumn {
  id: string
  label: string
}

/** Where a card being dragged would land, so its cell can show it. */
export interface Landing {
  columnId: string
  /** A day key, 'earlier' or 'all'. Null when the landing day is not on screen. */
  rowKey: string | null
  caption: string
  /** The instant that will place the card, so the outline sits where the card
   *  will in its cell's order. Without it the outline goes after the cards. */
  at?: number
}

/** What a cell needs to draw a landing outline. */
interface CellLanding {
  caption: string
  at?: number
}

/** What the Needs you column needs: the items for today's cell, and a way there. */
export interface NeedsYouSlot {
  total: number
  /** Drawn in today's cell. */
  content: ReactNode
  /** The rail's action when today is not on screen. */
  onGoToday: () => void
}

/** A run of quiet days (no work on any of them) that folds into one thin row. */
interface Fold {
  key: string
  from: number
  to: number
}

type Row =
  | { kind: 'earlier'; key: 'earlier' }
  /** The All view's one row: every task, without dates. */
  | { kind: 'all'; key: 'all' }
  | {
      kind: 'day'
      key: string
      day: number
      compact: boolean
      breakAfter: boolean
      /** The first day of a fold the person opened, which carries the control to
       *  fold it again. */
      unfolded?: Fold
    }
  | { kind: 'gap'; key: string; from: number; to: number; breakAfter: boolean }

/** "Thursday, October 15", or "Thursday, October 15 to Saturday, October 17". */
function foldLabel(fold: { from: number; to: number }): string {
  return isSameDay(fold.from, fold.to)
    ? longDate(fold.from)
    : `${longDate(fold.from)} to ${longDate(fold.to)}`
}

export interface CalendarGridProps {
  /** The days on screen, or null for the All view: one row holding every task. */
  range: CalendarRange | null
  now: number
  weekStartsOn: number
  /** Weekdays to shade, in `Date#getDay` numbering. */
  weekend: ReadonlySet<number>
  /** The day the person picked, whose row is lit across the board, or null. */
  selectedDay: number | null
  onSelectDay: (day: number | null) => void
  columns: CalendarColumn[]
  buckets: TaskBuckets<BoardTask>
  runsByDay: Map<string, DayRuns<RoutineOccurrences>[]>
  /** The soonest routine run on screen, marked "Next". */
  nextRunAt: number | null
  /** Open work from before the range gets its own first row. */
  showEarlier: boolean
  /** Whether that row shows its cards, or only says what it holds. */
  earlierOpen: boolean
  onEarlierOpenChange: (open: boolean) => void
  needsYou: NeedsYouSlot
  cancelledOpen: boolean
  onCancelledOpenChange: (open: boolean) => void
  /** Cards a capped cell always shows: the one open in the drawer, the one just
   *  added or moved. */
  pinnedIds: ReadonlySet<string>
  /** The card being dragged, the column it is drawn in, and the column it is over. */
  drag: { task: BoardTask; ownColumn: string; overColumn: string | null } | null
  landing: Landing | null
  columnDropDisabled: (columnId: string) => boolean
  cardDisabled: (task: BoardTask) => boolean
  onCardOpen: (id: string) => void
  onRunOpen: (run: RoutineOccurrences, anchor: HTMLElement) => void
  /** The card whose drawer is open, or null. */
  openTaskId: string | null
  /** Cards an agent just put where they are. */
  arrivedIds: ReadonlySet<string>
  /** The card the person just set down, or null. */
  settleId: string | null
  /** The `focusId` of the routine run whose popover is open, or null. */
  openRunKey: string | null
  /** Bumps each time Today or T has brought today into view; 0 means never. */
  todayPing: number
  /** Cards that changed while the person was away. */
  unseenIds: ReadonlySet<string>
  /** The person has looked at a card that changed while they were away. */
  onSeen: (id: string) => void
  /** Opens New task, from the "+" in To do's title. */
  onNewTask?: () => void
}

/** The states a cell's cards draw from: which one is open, which just moved. */
interface CardStates {
  openTaskId: string | null
  arrivedIds: ReadonlySet<string>
  settleId: string | null
  openRunKey: string | null
  unseenIds: ReadonlySet<string>
  onSeen: (id: string) => void
  now: number
}

/** Where a card sits, which decides how much of its date the stamp needs. */
export type StampPlace = 'day' | 'earlier' | 'all'

/** When a running task's current run started, from the board read. */
function runningSinceOf(task: BoardTask): number | null {
  const v = task['runningSince']
  return task.status === 'in_progress' && typeof v === 'number' && v > 0 ? v : null
}

/**
 * A calendar card's stamp. A task that is running shows how long its run has
 * gone; any other shows when it was added or finished. A card on a day row
 * shows the time, one from before the range its date, and one on the Kanban
 * board how long ago ("4m ago", "Yesterday").
 */
export function calendarStamp(
  task: BoardTask,
  place: StampPlace,
  now: number,
): CardStamp | undefined {
  const at = taskPlacedAt(task)
  const verb =
    task.status === 'cancelled' ? 'Cancelled' : isFinishedStatus(task.status) ? 'Finished' : 'Added'
  const when = at == null ? null : `${verb} ${shortDate(at)} at ${timeLabel(at)}`
  const since = runningSinceOf(task)
  if (since != null) {
    return {
      label: elapsedLabel(now - since),
      title: [`Running since ${timeOnDay(since, now)}`, when].filter(Boolean).join('. '),
      running: true,
    }
  }
  if (at == null || when == null) return undefined
  // On the Kanban board no row gives the day, so the card says how long ago.
  if (place === 'all') return { label: agoLabel(at, now), title: when }
  // The weekday and the time are in the title.
  return { label: place === 'earlier' ? dayMonth(at) : timeLabel(at), title: when }
}

function placeOf(row: Row): StampPlace {
  return row.kind === 'earlier' ? 'earlier' : row.kind === 'all' ? 'all' : 'day'
}

// ─── Row shading ────────────────────────────────────────────────────────────

interface Tone {
  today: boolean
  past: boolean
  weekend: boolean
  /** The person picked this date, so its whole row is lit. */
  selected: boolean
}

function rowTone(
  row: Row,
  now: number,
  weekend: ReadonlySet<number>,
  selectedKey: string | null,
): Tone {
  const today = startOfDay(now)
  if (row.kind === 'earlier') return { today: false, past: true, weekend: false, selected: false }
  if (row.kind === 'all') return { today: false, past: false, weekend: false, selected: false }
  if (row.kind === 'gap')
    return { today: false, past: row.to < today, weekend: false, selected: false }
  return {
    today: isSameDay(row.day, now),
    past: row.day < today,
    weekend: weekend.has(new Date(row.day).getDay()),
    selected: row.key === selectedKey,
  }
}

/** A picked day's fill in the lanes: the lane, a step darker. */
const SELECTED_LANE = 'rgb(var(--foreground-rgb) / 0.07)'

/** Whether the rule under a row is the firm one: a week break in a month, and
 *  the line under Earlier. */
function fullRule(row: Row): boolean {
  return row.kind === 'earlier' || (row.kind !== 'all' && row.breakAfter)
}

/** The gutter sits on the board's canvas, opaque so cards scrolling under it
 *  never show through. Only a picked date fills its row. */
function gutterStyle(tone: Tone): CSSProperties {
  return {
    backgroundColor: tone.selected
      ? 'color-mix(in srgb, var(--foreground) 4.5%, var(--surface))'
      : 'var(--surface)',
  }
}

// A day's rule stops short of the lane's edges, so the lanes run unbroken and
// the days read as steps inside them. It is drawn in the cell's transparent
// bottom border.
const LANE_RULE_INSET = 8

/** A cell's fill and rule. The fill is the column's `--lane`; the first row
 *  rounds the lane's top. */
function cellStyle(tone: Tone, row: Row, first = false): CSSProperties {
  const rule = fullRule(row) ? 'var(--border-strong)' : 'var(--border)'
  return {
    backgroundColor: tone.selected ? SELECTED_LANE : 'var(--lane)',
    borderBottom: '1px solid transparent',
    backgroundImage: `linear-gradient(${rule}, ${rule})`,
    backgroundOrigin: 'border-box',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center bottom',
    backgroundSize: `calc(100% - ${LANE_RULE_INSET * 2}px) 1px`,
    ...(first ? { borderTopLeftRadius: LANE_RADIUS, borderTopRightRadius: LANE_RADIUS } : null),
  }
}

/** The lane under the last row, down to the bottom of the board. */
function LaneEnd() {
  return (
    <div
      aria-hidden
      style={{
        backgroundColor: 'var(--lane)',
        borderBottomLeftRadius: LANE_RADIUS,
        borderBottomRightRadius: LANE_RADIUS,
      }}
    />
  )
}

// ─── Day gutter ─────────────────────────────────────────────────────────────

// The gutter is a picture of the dates. A screen reader hears the day in every
// cell's own label instead, so the picture is hidden from it; what it can reach
// are the controls: each date, which lights its row, and the Earlier toggle.
function DayHeader({
  row,
  first,
  tone,
  now,
  tasks,
  runs,
  earlierParts,
  earlierOpen,
  onToggleEarlier,
  onToggleFold,
  onSeamHover,
  onSelect,
  rangeStart,
  todayPing,
}: {
  row: Row
  first: boolean
  tone: Tone
  now: number
  tasks: number
  runs: { count: number; more: boolean }
  /** What the Earlier row holds, one phrase a line: "1 running", "2 parked". */
  earlierParts: string[]
  earlierOpen: boolean
  onToggleEarlier: () => void
  /** Open a fold of quiet days, or fold one again. */
  onToggleFold: (fold: Fold) => void
  /** The pointer is over a seam's handle, so the seam across the board lights. */
  onSeamHover: (key: string, on: boolean) => void
  /** Light this row, or put it out when it is already lit. */
  onSelect: (day: number | null) => void
  rangeStart: number
  /** Today's circle pings each time this bumps; 0 means it never has. */
  todayPing: number
}) {
  const base = gutterStyle(tone)

  if (row.kind === 'all') {
    return (
      <div data-testid="calendar-row-all" className="px-1.5 py-2.5" style={base}>
        <div
          aria-hidden
          className="flex flex-col items-center whitespace-nowrap text-micro tabular-nums text-muted-foreground"
        >
          {/* The corner already says All. */}
          <span className="text-foreground">{countLabel(tasks, 'task')}</span>
          <span>newest first</span>
        </div>
      </div>
    )
  }

  if (row.kind === 'earlier') {
    const Chevron = earlierOpen ? ChevronDown : ChevronRight
    return (
      <div data-testid="calendar-row-earlier" className="px-1.5 py-2.5" style={base}>
        <button
          type="button"
          onClick={onToggleEarlier}
          aria-expanded={earlierOpen}
          aria-label={`Earlier: open work added before ${longDate(rangeStart)}, ${
            earlierParts.length > 0 ? earlierParts.join(', ') : countLabel(tasks, 'task')
          }`}
          className="flex w-full cursor-pointer items-center justify-center gap-0.5 rounded-md py-0.5 text-micro font-semibold text-foreground transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Chevron
            size={12}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          Earlier
        </button>
        <div
          aria-hidden
          className="mt-1 flex flex-col items-center whitespace-nowrap text-micro tabular-nums text-muted-foreground"
        >
          <span>Before</span>
          <span>{dayMonth(rangeStart)}</span>
          {/* What it holds, so a folded row still says whether anything is
              running or waiting to start. */}
          {earlierParts.map((part) => (
            <span key={part} data-testid="calendar-earlier-part" className="text-foreground">
              {part}
            </span>
          ))}
        </div>
      </div>
    )
  }

  if (row.kind === 'gap') {
    // Folded quiet days are a seam, the way a spreadsheet shows hidden rows: a
    // pinched line across the board, and in the date column a small handle that
    // opens it. The dates either side of the seam say which days it holds, and
    // the handle repeats them.
    const single = isSameDay(row.from, row.to)
    const sameMonth = new Date(row.from).getMonth() === new Date(row.to).getMonth()
    const span = single
      ? `${weekdayShort(row.from)} ${new Date(row.from).getDate()}`
      : `${new Date(row.from).getDate()}\u2013${sameMonth ? new Date(row.to).getDate() : dayMonth(row.to)}`
    return (
      <div
        data-testid="calendar-row-gap"
        className="board-seam-gutter relative"
        style={{ ...base, height: SEAM_H }}
      >
        {/* The visible handle is small; the button around it is the gutter's
            width and 24px tall, reaching a few pixels into the rows either side,
            so it is an easy target. */}
        <button
          type="button"
          data-fold-toggle={row.key}
          aria-expanded={false}
          aria-label={`${foldLabel(row)}, no work. Show ${single ? 'the day' : 'the days'}`}
          title={single ? 'Nothing on this day. Show it' : 'Nothing on these days. Show them'}
          onClick={() => onToggleFold(row)}
          onPointerEnter={() => onSeamHover(row.key, true)}
          onPointerLeave={() => onSeamHover(row.key, false)}
          className="group absolute inset-x-0 top-1/2 z-[2] flex h-6 -translate-y-1/2 cursor-pointer items-center justify-center focus-visible:outline-none!"
        >
          <span
            aria-hidden
            className="board-seam-handle flex h-4 items-center gap-1 rounded-full px-1.5 text-micro leading-none font-medium tabular-nums whitespace-nowrap text-muted-foreground group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-foreground"
          >
            <UnfoldVertical size={10} strokeWidth={2} className="shrink-0" />
            {span}
          </span>
        </button>
      </div>
    )
  }

  // The month shows under the 1st, unless the 1st opens the range, whose title
  // already names it.
  const monthStart = !first && new Date(row.day).getDate() === 1
  const dim = tone.past && !tone.today && !tone.selected
  // A day gone by, or a weekend, reads its weekday in the muted ink.
  const quietWeekday = dim || (tone.weekend && !tone.today && !tone.selected)
  const weekday = (
    <span className={`board-micro ${quietWeekday ? 'text-muted-foreground' : 'text-foreground'}`}>
      {weekdayShort(row.day)}
    </span>
  )
  // Today keeps its red circle when picked, with a ring round it; any other
  // picked date gets an ink circle.
  const circle = tone.today
    ? 'bg-primary-solid font-semibold text-primary-foreground'
    : tone.selected
      ? 'bg-foreground font-semibold text-background'
      : dim
        ? 'font-medium text-muted-foreground'
        : 'font-semibold text-foreground'
  const ring =
    tone.today && tone.selected
      ? '0 0 0 2px var(--surface), 0 0 0 3.5px rgb(var(--primary-rgb) / 0.45)'
      : undefined
  // The gutter has room for the date alone. Which day this is to today, and how
  // much is on it, are in the tooltip.
  const relative = relativeDayWord(row.day, now)
  const runWord = runs.count === 1 && !runs.more ? 'run' : 'runs'
  const load = [
    tasks > 0 ? countLabel(tasks, 'task') : null,
    runs.count > 0 ? `${runs.count}${runs.more ? '+' : ''} ${runWord}` : null,
  ].filter((x): x is string => x != null)
  const title = [
    `${longDate(row.day)}${relative ? `, ${relative.toLowerCase()}` : ''}`,
    load.length > 0 ? `. ${load.join(', ')}` : '',
    tone.selected ? '. Click to clear the highlight.' : '. Click to highlight the day.',
  ].join('')
  const button = {
    type: 'button' as const,
    onClick: () => onSelect(tone.selected ? null : row.day),
    'aria-pressed': tone.selected,
    'aria-label': `Highlight ${longDate(row.day)}${tone.today ? ', today' : ''}`,
    title,
  }
  // The date sits flush with the board's left edge, so its ring is drawn inside
  // it. The global ring's offset is unlayered and outranks a plain utility, so
  // the inset offset is marked important.
  const buttonClass =
    'w-full cursor-pointer transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2!'

  if (row.compact) {
    return (
      <div
        data-testid={`calendar-day-${row.key}`}
        data-day-key={row.key}
        data-today={tone.today || undefined}
        data-selected={tone.selected || undefined}
        className="relative flex min-h-9"
        style={base}
      >
        {row.unfolded ? (
          <button
            type="button"
            data-fold-toggle={row.unfolded.key}
            aria-expanded
            aria-label={`${foldLabel(row.unfolded)}, no work. Fold ${
              isSameDay(row.unfolded.from, row.unfolded.to) ? 'the day' : 'the days'
            }`}
            title={
              isSameDay(row.unfolded.from, row.unfolded.to) ? 'Fold this day' : 'Fold these days'
            }
            onClick={() => onToggleFold(row.unfolded!)}
            className="absolute left-0.5 top-1/2 z-[1] flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-0!"
          >
            <FoldVertical size={12} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
        <button
          {...button}
          className={`${buttonClass} flex items-center justify-center ${row.unfolded ? 'pl-[22px] pr-1' : 'px-1'}`}
        >
          {/* The weekday, then the numeral, in the order a full row stacks them,
              on one baseline as words on a line are. */}
          <span aria-hidden className="flex items-baseline gap-1.5">
            {monthStart ? (
              <span className="flex flex-col items-end">
                {weekday}
                <span className="text-micro text-muted-foreground">{monthShort(row.day)}</span>
              </span>
            ) : (
              weekday
            )}
            <span
              className={[
                'font-display font-display-cut flex size-6 shrink-0 items-center justify-center rounded-full text-sm leading-none',
                circle,
              ].join(' ')}
              style={{ boxShadow: ring }}
            >
              {new Date(row.day).getDate()}
            </span>
          </span>
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid={`calendar-day-${row.key}`}
      data-day-key={row.key}
      data-today={tone.today || undefined}
      data-selected={tone.selected || undefined}
      className="flex"
      style={base}
    >
      <button
        {...button}
        className={`${buttonClass} flex flex-col items-center justify-start px-1 py-2.5`}
      >
        <span aria-hidden className="flex flex-col items-center">
          {weekday}
          <span
            className={[
              'font-display font-display-cut relative mt-1 flex size-7 shrink-0 items-center justify-center rounded-full text-xl leading-none',
              circle,
            ].join(' ')}
            style={{ boxShadow: ring }}
          >
            {new Date(row.day).getDate()}
            {/* Keyed by the count, so each bump plays the ring again. */}
            {tone.today && todayPing > 0 ? (
              <span key={todayPing} aria-hidden className="board-today-ping" />
            ) : null}
          </span>
          {monthStart ? (
            <span className="mt-0.5 text-micro text-muted-foreground">{monthShort(row.day)}</span>
          ) : null}
        </span>
      </button>
    </div>
  )
}

// ─── Cells ──────────────────────────────────────────────────────────────────

function whereLabel(row: Row, tone: Tone): string {
  if (row.kind === 'earlier') return 'from earlier'
  if (row.kind === 'all') return 'across all dates'
  if (row.kind === 'gap')
    return isSameDay(row.from, row.to)
      ? `on ${longDate(row.from)}`
      : `${shortDate(row.from)} to ${shortDate(row.to)}`
  return `on ${longDate(row.day)}${tone.today ? ', today' : ''}`
}

/** A cell with nothing a person can reach: a folded column, or Needs you on a
 *  day that is not today. It keeps the row's shading and rule. */
function Spacer({ row, tone, first }: { row: Row; tone: Tone; first: boolean }) {
  return <div aria-hidden style={cellStyle(tone, row, first)} />
}

/** The dashed outline that shows where a dragged card will land. */
function LandingOutline({ caption }: { caption: string }) {
  return (
    <div
      data-testid="calendar-landing"
      className="flex h-10 shrink-0 items-center justify-center rounded-lg border border-dashed text-xs font-medium text-foreground"
      style={{
        borderColor: 'color-mix(in srgb, var(--foreground) 35%, transparent)',
        background: 'var(--surface)',
      }}
    >
      {caption}
    </div>
  )
}

function Cell({
  column,
  row,
  tone,
  first,
  tasks,
  runs,
  cap,
  runCap,
  pinnedIds,
  expanded,
  onToggleExpanded,
  landing,
  nextRunAt,
  earlierOpen,
  cardDisabled,
  onCardOpen,
  onRunOpen,
  states,
}: {
  column: CalendarColumn
  row: Row
  tone: Tone
  /** The lane's first row, which rounds its top. */
  first: boolean
  tasks: BoardTask[]
  runs: DayRuns<RoutineOccurrences>[]
  cap: number
  runCap: number
  pinnedIds: ReadonlySet<string>
  expanded: boolean
  onToggleExpanded: () => void
  landing: CellLanding | null
  nextRunAt: number | null
  earlierOpen: boolean
  cardDisabled: (task: BoardTask) => boolean
  onCardOpen: (id: string) => void
  onRunOpen: (run: RoutineOccurrences, anchor: HTMLElement) => void
  states: CardStates
}) {
  const folded = row.kind === 'earlier' && !earlierOpen
  const shownRuns = folded ? [] : expanded ? runs : runs.slice(0, runCap)
  const shownTasks = folded ? [] : expanded ? tasks : pickShown(tasks, cap, pinnedIds)
  const hidden = folded ? 0 : runs.length - shownRuns.length + (tasks.length - shownTasks.length)
  const empty = runs.length === 0 && tasks.length === 0
  // Finished work from a day before today steps back, in a past day's row or in
  // the All view's one row; on today, and in Earlier (which only holds open
  // work), it does not.
  const finishedBefore = (t: BoardTask): boolean => {
    if (!isFinishedStatus(t.status)) return false
    if (row.kind === 'day') return tone.past
    if (row.kind !== 'all') return false
    const at = taskPlacedAt(t)
    return at != null && at < startOfDay(states.now)
  }
  // Where the outline goes: the All row lists newest first, every other row
  // oldest first, so the card lands before the first card it would sort ahead of.
  const landingIndex = (() => {
    if (!landing) return -1
    const at = landing.at
    if (at == null) return shownTasks.length
    const newestFirst = row.kind === 'all'
    const i = shownTasks.findIndex((t) => {
      const placed = taskAnchor(t, states.now)
      return newestFirst ? placed < at : placed > at
    })
    return i === -1 ? shownTasks.length : i
  })()
  return (
    <div
      role="group"
      aria-label={`${column.label} ${whereLabel(row, tone)}: ${
        empty
          ? 'nothing'
          : [
              tasks.length ? countLabel(tasks.length, 'task') : null,
              runs.length ? countLabel(runs.length, 'routine') : null,
            ]
              .filter(Boolean)
              .join(', ')
      }`}
      data-testid={`calendar-cell-${column.id}-${row.key}`}
      data-selected={tone.selected || undefined}
      className={`flex min-w-0 flex-col gap-2 transition-colors duration-150 ${
        row.kind === 'day' && row.compact ? 'px-2 py-1.5' : 'p-2'
      }`}
      style={cellStyle(tone, row, first)}
    >
      {/* The day's work first, then what is still to come: a routine's runs are
          a promise, not work, so they sit under the cards. A dragged card's
          outline sits where the card will land among them. */}
      {shownTasks.map((t, i) => (
        <Fragment key={t.id}>
          {landing && i === landingIndex ? <LandingOutline caption={landing.caption} /> : null}
          <DraggableCard
            key={t.id}
            task={t}
            disabled={cardDisabled(t)}
            onOpen={() => onCardOpen(t.id)}
            stamp={calendarStamp(t, placeOf(row), states.now)}
            open={t.id === states.openTaskId}
            past={finishedBefore(t)}
            // Finished work from a day gone by keeps its title to one line, unless
            // it is open in the drawer or was just touched.
            clamp={finishedBefore(t) && !pinnedIds.has(t.id)}
            arrived={states.arrivedIds.has(t.id)}
            settle={t.id === states.settleId}
            unseen={states.unseenIds.has(t.id)}
            onSeen={() => states.onSeen(t.id)}
          />
        </Fragment>
      ))}
      {landing && landingIndex === shownTasks.length ? (
        <LandingOutline caption={landing.caption} />
      ) : null}
      {shownRuns.map((r) => {
        const focusId = `routine-run:${r.routine.schedule.id}:${row.key}`
        // The day can hold the next run behind a first run that may be skipped.
        const nextAt = nextRunAt != null && r.times.includes(nextRunAt) ? nextRunAt : null
        return (
          <RoutineRunStrip
            key={r.routine.schedule.id}
            day={r}
            nextAt={nextAt}
            focusId={focusId}
            open={states.openRunKey === focusId}
            onOpen={(anchor) => onRunOpen(r.routine, anchor)}
            // Today's runs and the next one get the full strip; every other run
            // is one line, so a busy routine week does not crowd out the work.
            line={(row.kind === 'day' && row.compact) || !(tone.today || nextAt != null)}
          />
        )
      })}
      {row.kind === 'all' && empty && !landing ? (
        <span data-testid="board-lane-empty" className="px-1 py-0.5 text-xs text-muted-foreground">
          {EMPTY_LANE[column.id] ?? 'No tasks'}
        </span>
      ) : null}
      {hidden > 0 || (expanded && (runs.length > runCap || tasks.length > cap)) ? (
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="self-start cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {expanded ? 'Show less' : `+${hidden} more`}
        </button>
      ) : null}
    </div>
  )
}

// ─── Columns ────────────────────────────────────────────────────────────────

/** A column's sticky title: its status glyph, the name, and the count as a
 *  plain number beside it. An empty column shows no count at all. */
function ColumnTitle({
  glyph,
  label,
  count,
  children,
}: {
  glyph: ReactNode
  label: string
  count: number
  children?: ReactNode
}) {
  return (
    <>
      {glyph}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-xs font-semibold text-foreground">{label}</span>
        {count > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </span>
      {children}
    </>
  )
}

/** Every sticky header cell. It sits on the canvas above its lane, and
 *  `board-col-head` lifts it off the rows with a shadow once the board has
 *  scrolled down. */
const HEADER_BASE = 'board-col-head sticky top-0 z-[2] flex items-center'
const HEADER_CLASS = `${HEADER_BASE} gap-2 pl-3 pr-1`
/** A folded column's header holds only its count, centred in the narrow rail. */
const RAIL_HEADER_CLASS = `${HEADER_BASE} justify-center px-1`
const HEADER_STYLE = {
  height: HEADER_H,
  background: 'var(--surface)',
}
/** The round ghost buttons in a column's title. */
const HEAD_BUTTON =
  'ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2'

/** A rail: a folded column's full-height button, its name running down the side
 *  in sentence case. It fills the column, so its focus ring is drawn inside it
 *  (marked important to outrank the global ring's offset). */
function Rail({
  testId,
  label,
  name,
  caption,
  onClick,
  railRef,
}: {
  testId: string
  label: string
  name: string
  /** Shown in place of the name while a dragged card is over the rail: what
   *  letting go there does, which a folded column has no cell to say. */
  caption?: string
  onClick: () => void
  railRef?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={railRef}
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-label={label}
      className="absolute inset-0 z-[3] flex cursor-pointer flex-col items-center rounded-xl transition-colors hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2!"
      style={{ paddingTop: HEADER_H + 12 }}
    >
      <span
        aria-hidden
        data-testid={caption ? `${testId}-caption` : undefined}
        className={[
          'sticky text-xs font-semibold',
          caption ? 'text-foreground' : 'text-muted-foreground',
        ].join(' ')}
        style={{ top: HEADER_H + 12, writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
      >
        {caption ?? name}
      </span>
    </button>
  )
}

/** A column element: one grid item spanning every row, laying its cells on the
 *  parent's rows. `--lane` is the fill its cells paint. */
function columnStyle(gridColumn: number, lane: string): CSSProperties {
  return {
    gridColumn,
    gridRow: '1 / -1',
    display: 'grid',
    gridTemplateRows: 'subgrid',
    ['--lane' as string]: lane,
  }
}

function NeedsYouColumn({
  gridColumn,
  rows,
  tones,
  hostKey,
  needsYou,
  dragging,
  landing,
}: {
  gridColumn: number
  rows: Row[]
  tones: Map<string, Tone>
  /** The row that holds Needs you: today's, the All view's one row, or null when
   *  neither is on screen and the column folds to a rail. */
  hostKey: string | null
  needsYou: NeedsYouSlot
  /** A card is being dragged. Needs you takes no card itself, so it steps back,
   *  unless the drop would land the card here (a To do with no agent). */
  dragging: boolean
  landing: Landing | null
}) {
  const landsHere = landing?.columnId === NEEDS_YOU_COLUMN
  const { total } = needsYou
  const rail = hostKey === null
  const onToday = hostKey !== null && hostKey !== 'all'
  const items = total === 1 ? '1 item' : `${total} items`
  return (
    <div
      data-testid="board-column-needs-you"
      role="group"
      aria-label={`Needs you, ${items}`}
      className="relative transition-opacity duration-150"
      style={{
        ...columnStyle(gridColumn, landsHere ? LANE_OVER : LANE),
        opacity: dragging && !landsHere ? DIM_WHILE_DRAGGING : 1,
      }}
    >
      <div className={rail ? RAIL_HEADER_CLASS : HEADER_CLASS} style={HEADER_STYLE}>
        {rail ? (
          <span
            className={[
              'text-xs font-semibold tabular-nums',
              total > 0 ? 'text-foreground' : 'text-muted-foreground',
            ].join(' ')}
          >
            {total}
          </span>
        ) : (
          <ColumnTitle
            glyph={<StatusGlyph kind="needs_you" muted={total === 0} />}
            label="Needs you"
            count={total}
          >
            {onToday ? (
              <span className="ml-auto pr-2 text-xs text-muted-foreground">Today</span>
            ) : null}
          </ColumnTitle>
        )}
      </div>
      {rows.map((row, i) => {
        const tone = tones.get(row.key)!
        if (row.key !== hostKey)
          return <Spacer key={row.key} row={row} tone={tone} first={i === 0} />
        return (
          <div
            key={row.key}
            role="group"
            tabIndex={-1}
            aria-label={`Needs you${onToday ? ' today' : ''}: ${total === 0 ? 'nothing' : items}`}
            data-testid="calendar-needs-you-today"
            className="flex min-w-0 flex-col gap-2 p-2 focus-visible:-outline-offset-2!"
            style={cellStyle(tone, row, i === 0)}
          >
            {landsHere && landing?.rowKey === row.key ? (
              <LandingOutline caption={landing.caption} />
            ) : null}
            {needsYou.content}
          </div>
        )
      })}
      <LaneEnd />
      {rail ? (
        <Rail
          testId="board-needs-you-rail"
          name="Needs you"
          label={`Needs you, ${total === 0 ? 'nothing waiting' : items}. Go to today.`}
          onClick={needsYou.onGoToday}
        />
      ) : null}
    </div>
  )
}

function StatusColumn({
  column,
  gridColumn,
  rows,
  tones,
  buckets,
  runsByDay,
  cap,
  runCap,
  pinnedIds,
  count,
  expandedCells,
  onToggleCell,
  landing,
  nextRunAt,
  earlierOpen,
  cancelledOpen,
  onCancelledOpenChange,
  dropDisabled,
  dragging,
  own,
  isOver,
  cardDisabled,
  onCardOpen,
  onRunOpen,
  onNewTask,
  states,
}: {
  column: CalendarColumn
  gridColumn: number
  rows: Row[]
  tones: Map<string, Tone>
  buckets: TaskBuckets<BoardTask>
  runsByDay: Map<string, DayRuns<RoutineOccurrences>[]>
  cap: number
  runCap: number
  pinnedIds: ReadonlySet<string>
  count: number
  expandedCells: ReadonlySet<string>
  onToggleCell: (key: string) => void
  landing: Landing | null
  nextRunAt: number | null
  earlierOpen: boolean
  cancelledOpen: boolean
  onCancelledOpenChange: (open: boolean) => void
  dropDisabled: boolean
  dragging: boolean
  /** The dragged card is drawn in this column, so letting go here changes
   *  nothing and the column does not light up as a target. */
  own: boolean
  isOver: boolean
  cardDisabled: (task: BoardTask) => boolean
  onCardOpen: (id: string) => void
  onRunOpen: (run: RoutineOccurrences, anchor: HTMLElement) => void
  /** Opens New task; To do, where a new task lands, carries a "+" for it. */
  onNewTask?: () => void
  states: CardStates
}) {
  const { setNodeRef, isOver: dndOver } = useDroppable({ id: column.id, disabled: dropDisabled })
  const over = (isOver || dndOver) && !dropDisabled && !own
  const rail = column.id === 'cancelled' && !cancelledOpen

  // Folding swaps the button that was pressed for its counterpart, in another
  // place in the tree; focus follows, or a keyboard user would land on the page.
  const railRef = useRef<HTMLButtonElement>(null)
  const foldRef = useRef<HTMLButtonElement>(null)
  const focusAfterToggle = useRef(false)
  useEffect(() => {
    if (!focusAfterToggle.current) return
    focusAfterToggle.current = false
    ;(rail ? railRef : foldRef).current?.focus()
  }, [rail])
  const toggle = (open: boolean) => {
    focusAfterToggle.current = true
    onCancelledOpenChange(open)
  }

  return (
    <div
      ref={setNodeRef}
      data-testid={`board-column-${column.id}`}
      role="group"
      aria-label={`${column.label}, ${countLabel(count, 'task')}`}
      className="relative transition-opacity duration-150"
      style={{
        ...columnStyle(gridColumn, over ? LANE_OVER : LANE),
        // A column that cannot take the card steps back while it is dragged.
        opacity: dragging && dropDisabled ? DIM_WHILE_DRAGGING : 1,
      }}
    >
      <div className={rail ? RAIL_HEADER_CLASS : HEADER_CLASS} style={HEADER_STYLE}>
        {rail ? (
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">{count}</span>
        ) : (
          <ColumnTitle
            glyph={<StatusGlyph kind={glyphKindOf(column.id)} />}
            label={column.label}
            count={count}
          >
            {column.id === 'cancelled' ? (
              <button
                ref={foldRef}
                type="button"
                onClick={() => toggle(false)}
                aria-label="Fold the Cancelled column"
                title="Fold"
                className={HEAD_BUTTON}
              >
                <EyeOff size={14} strokeWidth={2} />
              </button>
            ) : column.id === 'todo' && onNewTask ? (
              <button
                type="button"
                onClick={onNewTask}
                aria-label="Add a task to To do"
                title="New task (C)"
                className={HEAD_BUTTON}
              >
                <Plus size={14} strokeWidth={2} />
              </button>
            ) : null}
          </ColumnTitle>
        )}
      </div>
      {rows.map((row, i) => {
        const tone = tones.get(row.key)!
        if (rail || row.kind === 'gap')
          return <Spacer key={row.key} row={row} tone={tone} first={i === 0} />
        // The All view's one row is a cell like any day's, keyed 'all'.
        const tasks =
          row.kind === 'earlier'
            ? (buckets.earlier.get(column.id) ?? [])
            : (buckets.cells.get(column.id)?.get(row.key) ?? [])
        const runs =
          column.id === 'todo' && row.kind === 'day' ? (runsByDay.get(row.key) ?? []) : []
        const cellKey = `${column.id}:${row.key}`
        return (
          <Cell
            key={row.key}
            column={column}
            row={row}
            tone={tone}
            first={i === 0}
            tasks={tasks}
            runs={runs}
            // The Today view uncaps its own day, but not the Earlier row above
            // it, which could otherwise push today out of sight.
            cap={row.kind === 'earlier' ? Math.min(cap, EARLIER_CAP) : cap}
            runCap={runCap}
            pinnedIds={pinnedIds}
            expanded={expandedCells.has(cellKey)}
            onToggleExpanded={() => onToggleCell(cellKey)}
            landing={
              landing && landing.columnId === column.id && landing.rowKey === row.key
                ? { caption: landing.caption, ...(landing.at != null ? { at: landing.at } : {}) }
                : null
            }
            nextRunAt={nextRunAt}
            earlierOpen={earlierOpen}
            cardDisabled={cardDisabled}
            onCardOpen={onCardOpen}
            onRunOpen={onRunOpen}
            states={states}
          />
        )
      })}
      <LaneEnd />
      {rail ? (
        <Rail
          railRef={railRef}
          testId="board-cancelled-rail"
          name="Cancelled"
          caption={over && landing?.columnId === column.id ? landing.caption : undefined}
          label={`Cancelled, ${countLabel(count, 'task')}. Show the column.`}
          onClick={() => toggle(true)}
        />
      ) : null}
    </div>
  )
}

// ─── Grid ───────────────────────────────────────────────────────────────────

function buildRows(
  range: CalendarRange,
  now: number,
  weekStartsOn: number,
  /** The day holds a task in a column on screen. */
  hasWork: (key: string) => boolean,
  /** The day holds an upcoming routine run. */
  hasRuns: (key: string) => boolean,
  withEarlier: boolean,
  /** Days that never fold even when quiet: the one the person picked. */
  keep: (day: number) => boolean,
  /** Quiet days the person opened, by day key. */
  opened: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = withEarlier ? [{ kind: 'earlier', key: 'earlier' }] : []
  const isWeekStart = (d: number) => new Date(d).getDay() === weekStartsOn
  const breakAfter = (d: number) => range.mode === 'month' && isWeekStart(addDays(d, 1))
  // A quiet day holds no work. It folds, with the quiet days beside it, into one
  // thin row, so the days that have something on them get the room. A day with
  // nothing on it but routine runs keeps its own thin row with the runs on one
  // line, never merged into a fold, so each run keeps its date. Today and a
  // picked day never fold, and in a month a fold stops at a week edge so the
  // week lines survive.
  const full = (d: number) => isSameDay(d, now) || keep(d) || hasWork(dayKey(d))
  const quiet = (d: number) => !full(d) && !hasRuns(dayKey(d))
  const days = range.days
  for (let i = 0; i < days.length; i++) {
    const day = days[i]!
    if (!quiet(day)) {
      rows.push({
        kind: 'day',
        key: dayKey(day),
        day,
        compact: !full(day),
        breakAfter: breakAfter(day),
      })
      continue
    }
    // A stretch is quiet days in a row that are all open or all folded, so
    // picking a date inside an open stretch leaves the days either side open.
    const isOpen = opened.has(dayKey(day))
    let j = i
    while (
      j + 1 < days.length &&
      quiet(days[j + 1]!) &&
      opened.has(dayKey(days[j + 1]!)) === isOpen &&
      !(range.mode === 'month' && isWeekStart(days[j + 1]!))
    )
      j++
    const fold: Fold = { key: `${dayKey(day)}..${dayKey(days[j]!)}`, from: day, to: days[j]! }
    if (isOpen) {
      for (let k = i; k <= j; k++) {
        const d = days[k]!
        rows.push({
          kind: 'day',
          key: dayKey(d),
          day: d,
          compact: true,
          breakAfter: breakAfter(d),
          ...(k === i ? { unfolded: fold } : {}),
        })
      }
    } else {
      rows.push({
        kind: 'gap',
        key: fold.key,
        from: day,
        to: days[j]!,
        breakAfter: breakAfter(days[j]!),
      })
    }
    i = j
  }
  return rows
}

export function CalendarGrid(props: CalendarGridProps) {
  const {
    range,
    now,
    weekStartsOn,
    weekend,
    selectedDay,
    onSelectDay,
    columns,
    buckets,
    runsByDay,
    nextRunAt,
    showEarlier,
    earlierOpen,
    onEarlierOpenChange,
    needsYou,
    cancelledOpen,
    onCancelledOpenChange,
    pinnedIds,
    drag,
    landing,
    columnDropDisabled,
    cardDisabled,
    onCardOpen,
    onRunOpen,
    openTaskId,
    arrivedIds,
    settleId,
    openRunKey,
    todayPing,
    unseenIds,
    onSeen,
    onNewTask,
  } = props
  const states = useMemo<CardStates>(
    () => ({ openTaskId, arrivedIds, settleId, openRunKey, unseenIds, onSeen, now }),
    [openTaskId, arrivedIds, settleId, openRunKey, unseenIds, onSeen, now],
  )
  // Quiet days the person opened, by day key. The grid is drawn afresh for each
  // range, so every range starts folded.
  const [openedDays, setOpenedDays] = useState<ReadonlySet<string>>(() => new Set())
  const gridRef = useRef<HTMLDivElement>(null)
  // The fold toggle that was pressed is swapped for its counterpart (the thin row
  // for the first opened day, and back), so focus follows it there.
  const focusFoldRef = useRef<string | null>(null)
  const toggleFold = (fold: Fold) => {
    focusFoldRef.current = fold.key
    setOpenedDays((prev) => {
      const next = new Set(prev)
      const open = !next.has(dayKey(fold.from))
      for (let d = fold.from; d <= fold.to; d = addDays(d, 1)) {
        if (open) next.add(dayKey(d))
        else next.delete(dayKey(d))
      }
      return next
    })
  }
  useEffect(() => {
    const key = focusFoldRef.current
    if (key == null) return
    focusFoldRef.current = null
    Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-fold-toggle]') ?? [])
      .find((el) => el.dataset['foldToggle'] === key)
      ?.focus()
  }, [openedDays])
  // A seam's line and its handle light together. They are far apart in the
  // tree, so this marks both in place instead of re-rendering the grid on every
  // pointer move.
  const lightSeam = (key: string, on: boolean) => {
    const root = gridRef.current
    if (!root) return
    for (const el of root.querySelectorAll<HTMLElement>('[data-seam], [data-fold-toggle]')) {
      if (el.dataset['seam'] !== key && el.dataset['foldToggle'] !== key) continue
      if (on) el.setAttribute('data-hot', '')
      else el.removeAttribute('data-hot')
    }
  }
  const [expandedCells, setExpandedCells] = useState<ReadonlySet<string>>(() => new Set())
  // A week shows three cards a cell and a month two; a single day and the All
  // view have the room to show everything.
  const cap = range == null || range.mode === 'day' ? Infinity : range.mode === 'week' ? 3 : 2
  const runCap = range == null || range.mode === 'day' ? Infinity : RUN_CAP

  const earlierCount = useMemo(() => {
    let n = 0
    for (const col of columns) n += buckets.earlier.get(col.id)?.length ?? 0
    return n
  }, [buckets, columns])
  const withEarlier = showEarlier && earlierCount > 0
  // What Earlier holds, by how far along it is, so a folded row still says so.
  const earlierParts = useMemo(() => {
    const parts: string[] = []
    const order = [...EARLIER_ORDER, ...columns.map((c) => c.id)]
    for (const id of new Set(order)) {
      const n = buckets.earlier.get(id)?.length ?? 0
      if (n === 0) continue
      const column = columns.find((c) => c.id === id)
      parts.push(`${n} ${EARLIER_WORD[id] ?? (column?.label ?? id).toLowerCase()}`)
    }
    return parts
  }, [buckets, columns])

  // Columns whose cards are on screen. Folded Cancelled shows only a count, so its
  // tasks neither unfold a day nor add to the day's load line.
  const shownColumns = useMemo(
    () => columns.filter((c) => c.id !== 'cancelled' || cancelledOpen),
    [columns, cancelledOpen],
  )

  const rows = useMemo<Row[]>(() => {
    if (!range) return [{ kind: 'all', key: 'all' }]
    const hasWork = (key: string) =>
      shownColumns.some((c) => (buckets.cells.get(c.id)?.get(key)?.length ?? 0) > 0)
    const hasRuns = (key: string) => (runsByDay.get(key)?.length ?? 0) > 0
    const keep = (day: number) => selectedDay != null && isSameDay(day, selectedDay)
    return buildRows(range, now, weekStartsOn, hasWork, hasRuns, withEarlier, keep, openedDays)
  }, [
    range,
    now,
    weekStartsOn,
    runsByDay,
    shownColumns,
    buckets,
    withEarlier,
    selectedDay,
    openedDays,
  ])

  const selectedKey = selectedDay == null ? null : dayKey(selectedDay)
  const tones = useMemo(() => {
    const map = new Map<string, Tone>()
    for (const row of rows) map.set(row.key, rowTone(row, now, weekend, selectedKey))
    return map
  }, [rows, now, weekend, selectedKey])
  const todayKey = useMemo(() => {
    for (const row of rows) if (row.kind === 'day' && tones.get(row.key)?.today) return row.key
    return null
  }, [rows, tones])
  // Needs you sits in today's row, or in the All view's one row.
  const needsYouKey = todayKey ?? (range == null ? 'all' : null)

  const dayTotals = useMemo(() => {
    const totals = new Map<string, { tasks: number; runs: number; more: boolean }>()
    for (const row of rows) {
      if (row.kind !== 'day') continue
      let tasks = 0
      for (const c of shownColumns) tasks += buckets.cells.get(c.id)?.get(row.key)?.length ?? 0
      let runs = 0
      let more = false
      for (const r of runsByDay.get(row.key) ?? []) {
        runs += r.count
        more ||= r.more
      }
      totals.set(row.key, { tasks, runs, more })
    }
    return totals
  }, [rows, shownColumns, buckets, runsByDay])

  const columnCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of columns) {
      let n = withEarlier ? (buckets.earlier.get(c.id)?.length ?? 0) : 0
      for (const list of buckets.cells.get(c.id)?.values() ?? []) n += list.length
      counts.set(c.id, n)
    }
    return counts
  }, [columns, buckets, withEarlier])

  // Every card in the All view's row, for its gutter.
  const allCount = useMemo(() => {
    let n = 0
    for (const c of shownColumns) n += buckets.cells.get(c.id)?.get('all')?.length ?? 0
    return n
  }, [buckets, shownColumns])

  const toggleCell = (key: string) =>
    setExpandedCells((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // The Kanban board (no range) is one row of every task: it has no days, so no
  // date gutter, and its lanes keep the bars' side gutter instead.
  const kanban = range == null
  // Fixed tracks for the gutter, Needs you and the rails; the status columns
  // share whatever a wide screen has left over, never going under their minimum.
  const needsYouW = needsYouKey === null ? RAIL_W : NEEDS_YOU_W
  const tracks = columns.map((c) => {
    if (c.id === 'cancelled' && !cancelledOpen) return { css: `${RAIL_W}px`, min: RAIL_W }
    return { css: `minmax(${COLUMN_MIN}px, 1fr)`, min: COLUMN_MIN }
  })
  const template = [
    ...(kanban ? [] : [`${GUTTER_W}px`]),
    `${needsYouW}px`,
    ...tracks.map((t) => t.css),
  ].join(' ')
  const minWidth =
    (kanban ? KANBAN_PAD * 2 : GUTTER_W + LANE_GAP) +
    needsYouW +
    tracks.reduce((n, t) => n + t.min, 0) +
    tracks.length * LANE_GAP

  return (
    <div
      ref={gridRef}
      data-testid="board-calendar"
      data-mode={range?.mode ?? 'all'}
      className="grid"
      style={{
        gridTemplateColumns: template,
        // A last, flexible track takes whatever height the days leave, so a quiet
        // week still fills the board and the columns run to the bottom as drop
        // targets, while the day rows keep the height their content gives them.
        gridTemplateRows: `${HEADER_H}px repeat(${rows.length}, auto) 1fr`,
        columnGap: LANE_GAP,
        paddingInline: kanban ? KANBAN_PAD : undefined,
        minHeight: `calc(var(--board-vh, 100vh) - ${BOTTOM_PAD}px)`,
        minWidth,
        background: 'var(--surface)',
      }}
    >
      {kanban ? null : (
        <>
          {/* Day gutter: sticks to the left edge, its corner to the top as well. Each
          casts a shadow only once the board has scrolled under it. It sits above
          every layer in the columns, the rails included, so a board scrolled
          sideways passes under the dates. */}
          <div
            className="board-gutter sticky left-0 z-[4]"
            style={{
              gridColumn: 1,
              gridRow: '1 / -1',
              display: 'grid',
              gridTemplateRows: 'subgrid',
              background: 'var(--surface)',
            }}
          >
            {/* The corner is the board's legend: hover it to learn where a card sits. */}
            <div
              aria-hidden
              title="Open work sits on the day it was added, finished work on the day it finished."
              className="board-col-head sticky top-0 z-[3] flex items-center justify-center px-1"
              style={HEADER_STYLE}
            >
              <span className="board-micro whitespace-nowrap text-muted-foreground">
                {range == null
                  ? 'All'
                  : range.mode === 'month'
                    ? monthShort(range.start)
                    : `Week ${isoWeek(range.days[3] ?? range.start)}`}
              </span>
            </div>
            {rows.map((row, i) => {
              const totals = row.kind === 'day' ? dayTotals.get(row.key) : undefined
              return (
                <DayHeader
                  key={row.key}
                  row={row}
                  first={i === (withEarlier ? 1 : 0)}
                  tone={tones.get(row.key)!}
                  now={now}
                  tasks={
                    row.kind === 'earlier'
                      ? earlierCount
                      : row.kind === 'all'
                        ? allCount
                        : (totals?.tasks ?? 0)
                  }
                  runs={{ count: totals?.runs ?? 0, more: totals?.more ?? false }}
                  earlierParts={earlierParts}
                  earlierOpen={earlierOpen}
                  onToggleEarlier={() => onEarlierOpenChange(!earlierOpen)}
                  onToggleFold={toggleFold}
                  onSeamHover={lightSeam}
                  onSelect={onSelectDay}
                  rangeStart={range?.start ?? now}
                  todayPing={todayPing}
                />
              )
            })}
          </div>
        </>
      )}

      <NeedsYouColumn
        gridColumn={kanban ? 1 : 2}
        rows={rows}
        tones={tones}
        hostKey={needsYouKey}
        needsYou={needsYou}
        dragging={drag != null}
        landing={landing}
      />

      {columns.map((column, i) => (
        <StatusColumn
          key={column.id}
          column={column}
          gridColumn={(kanban ? 2 : 3) + i}
          rows={rows}
          tones={tones}
          buckets={buckets}
          runsByDay={runsByDay}
          cap={cap}
          runCap={runCap}
          pinnedIds={pinnedIds}
          count={columnCounts.get(column.id) ?? 0}
          expandedCells={expandedCells}
          onToggleCell={toggleCell}
          landing={landing}
          nextRunAt={nextRunAt}
          earlierOpen={earlierOpen}
          cancelledOpen={cancelledOpen}
          onCancelledOpenChange={onCancelledOpenChange}
          dropDisabled={columnDropDisabled(column.id)}
          dragging={drag != null}
          own={drag?.ownColumn === column.id}
          isOver={drag?.overColumn === column.id}
          cardDisabled={cardDisabled}
          onCardOpen={onCardOpen}
          onRunOpen={onRunOpen}
          onNewTask={onNewTask}
          states={states}
        />
      ))}

      {/* Each seam runs across the board as one line, over the lanes and under
          the column titles. Clicking anywhere on it opens the days, like its
          handle in the date column, which is the control a keyboard and a screen
          reader reach. */}
      {rows.map((row, i) =>
        row.kind === 'gap' ? (
          <div
            key={row.key}
            aria-hidden
            data-seam={row.key}
            data-testid="calendar-seam"
            className={`board-seam relative z-[1] ${drag != null ? 'pointer-events-none' : 'cursor-pointer'}`}
            style={{ gridColumn: '2 / -1', gridRow: i + 2 }}
            onClick={() => toggleFold(row)}
            onPointerEnter={() => lightSeam(row.key, true)}
            onPointerLeave={() => lightSeam(row.key, false)}
          />
        ) : null,
      )}
    </div>
  )
}
