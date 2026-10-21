// The calendar's time bar: back, home and forward on the left beside the range
// title (which opens the date picker), Find, the view and the routine switch on
// the right. While today is off screen, the Today button points the way to it.
// The Today view is today alone, so it has nothing to page through.
// Keyboard: T for today, the left and right arrows for the previous and next
// range, D, W, M and A for the views, / to find.

import { useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Repeat,
  Search,
  ShieldAlert,
} from 'lucide-react'

import { IconButton } from '@/features/shared/Button'
import { SegmentedControl } from '@/features/shared/SegmentedControl'

import { rangeRelation, rangeTitle } from './calendarFormat'
import type { CalendarMode, CalendarRange } from './calendarModel'
import { MiniMonth } from './MiniMonth'
import { RollingCount } from './RollingCount'

const MODE_OPTIONS: { id: CalendarMode; label: string }[] = [
  { id: 'day', label: 'Today' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All' },
]

/** Where today is from what is on screen: up or down the days, or another range. */
export type TodayDirection = 'up' | 'down' | 'left' | 'right'

const TODAY_ANGLE: Record<TodayDirection, number> = { up: 0, right: 90, down: 180, left: 270 }
const TODAY_WHERE: Record<TodayDirection, string> = {
  up: 'above',
  down: 'below',
  left: 'earlier',
  right: 'later',
}

/** The angle nearest `from` that points the same way as `to`, so the chevron
 *  turns the short way round. */
function turnTowards(from: number, to: number): number {
  return from + ((((to - from) % 360) + 540) % 360) - 180
}

/**
 * The Today chevron's rotation. It keeps pointing where it last pointed while
 * today is on screen (it is hidden then), so it fades rather than spins.
 */
function useTodayAngle(direction: TodayDirection | null): number {
  const [turn, setTurn] = useState(() => {
    const dir = direction ?? 'up'
    return { dir, angle: TODAY_ANGLE[dir] }
  })
  // Set during render, so the frame that shows a new direction already turns to it.
  if (direction && direction !== turn.dir) {
    setTurn({ dir: direction, angle: turnTowards(turn.angle, TODAY_ANGLE[direction]) })
  }
  return turn.angle
}

const TITLE_TYPE = 'font-display font-display-cut text-[20px] leading-[26px]'

export interface CalendarToolbarProps {
  mode: CalendarMode
  onModeChange: (mode: CalendarMode) => void
  range: CalendarRange | null
  now: number
  weekStartsOn: number
  activeDays: ReadonlySet<string>
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  /** Where today is, relative to the screen; null while today's row is on it. */
  todayDirection: TodayDirection | null
  onPickDate: (day: number) => void
  /** What the range holds. The column heads carry the task counts; the run total
   *  rides on the Routines switch. */
  summary: { tasks: number; runs: number; runsMore: boolean }
  showRoutines: boolean
  onShowRoutinesChange: (show: boolean) => void
  /** Shown while today's Needs you cell is out of view. */
  needsYou: { count: number; offscreen: boolean; onReveal: () => void }
  /** What the polite live region last said about a range change. */
  announcement: string
  /** Opens Find from its button. */
  onFind: (anchor: HTMLElement) => void
  findOpen: boolean
}

export function CalendarToolbar(props: CalendarToolbarProps) {
  const {
    mode,
    onModeChange,
    range,
    now,
    weekStartsOn,
    activeDays,
    onPrev,
    onNext,
    onToday,
    todayDirection,
    onPickDate,
    summary,
    showRoutines,
    onShowRoutinesChange,
    needsYou,
    announcement,
    onFind,
    findOpen,
  } = props
  const titleRef = useRef<HTMLButtonElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const todayAngle = useTodayAngle(todayDirection)
  const unit = mode === 'month' ? 'month' : 'week'
  const title = range ? rangeTitle(range) : null
  const pages = range != null && range.mode !== 'day'
  // The Today view's relation would only repeat its name.
  const relation = pages ? rangeRelation(range, now) : null
  // The run total rides on the Routines switch: "10", or "10+" when the read was capped.
  const runTotal = summary.runs > 0 ? `${summary.runs}${summary.runsMore ? '+' : ''}` : null
  const runWords = runTotal
    ? `${runTotal} upcoming routine ${summary.runs === 1 && !summary.runsMore ? 'run' : 'runs'}`
    : 'upcoming routine runs'

  return (
    <div
      data-testid="board-calendar-toolbar"
      className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-6 py-2"
    >
      {range && title ? (
        <div className="flex min-w-0 items-center gap-1">
          {pages ? (
            <>
              <button
                type="button"
                onClick={onToday}
                // "Today" is also the view beside it; this one goes there.
                aria-label="Go to today"
                title={
                  todayDirection ? `Today is ${TODAY_WHERE[todayDirection]} (T)` : 'Go to today (T)'
                }
                className="mr-1 inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-border pl-3 pr-2 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Today
                {/* Points the way to today while it is off screen. The slot is always
                there, so the button keeps its width as the chevron comes and goes. */}
                <ChevronUp
                  size={12}
                  strokeWidth={2.4}
                  aria-hidden
                  data-testid="board-today-direction"
                  data-direction={todayDirection ?? undefined}
                  className={[
                    'shrink-0 text-muted-foreground',
                    todayDirection ? 'opacity-100' : 'opacity-0',
                  ].join(' ')}
                  style={{
                    transform: `rotate(${todayAngle}deg)`,
                    transition:
                      'transform 180ms cubic-bezier(0.32, 0.72, 0, 1), opacity 150ms ease-out',
                  }}
                />
              </button>
              <IconButton size="sm" label={`Previous ${unit} (Left arrow)`} onClick={onPrev}>
                <ChevronLeft size={16} strokeWidth={2} />
              </IconButton>
              <IconButton size="sm" label={`Next ${unit} (Right arrow)`} onClick={onNext}>
                <ChevronRight size={16} strokeWidth={2} />
              </IconButton>
            </>
          ) : null}
          <button
            ref={titleRef}
            type="button"
            data-testid="board-range-title"
            onClick={() => setPickerOpen((o) => !o)}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            title="Choose a date"
            className="group ml-1.5 inline-flex min-w-0 cursor-pointer items-baseline gap-1.5 rounded-lg px-2 py-[3px] transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {/* "Oct 11 to 17, 2026" in a week, "October 2026" in a month. */}
            <span className={`${TITLE_TYPE} truncate font-semibold text-foreground`}>
              {title.dates}
              {range.mode !== 'month' && title.year ? ',' : null}
            </span>
            {/* The gap is drawn by the flex gap; this space is for the button's name. */}{' '}
            {title.year ? (
              <span className={`${TITLE_TYPE} font-normal text-muted-foreground`}>
                {title.year}
              </span>
            ) : null}
            <ChevronDown
              size={14}
              strokeWidth={2.2}
              className="self-center text-muted-foreground transition-transform group-aria-expanded:rotate-180"
              aria-hidden
            />
          </button>
          {relation ? (
            <span className="ml-1 hidden text-[12px] text-muted-foreground sm:inline">
              {relation}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={`${TITLE_TYPE} font-semibold text-foreground`}>All tasks</span>
          <span className="text-[12px] text-muted-foreground">Every task, newest first</span>
        </div>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
        <IconButton
          size="sm"
          label={range ? 'Find a task, an agent or a routine (/)' : 'Find a task or an agent (/)'}
          data-testid="board-find"
          aria-haspopup="dialog"
          aria-expanded={findOpen}
          onClick={(e) => onFind(e.currentTarget)}
        >
          <Search size={15} strokeWidth={2} />
        </IconButton>
        {/* Kept in the layout while hidden, so the bar never reflows (and the
            board never jumps) as it comes and goes. */}
        {needsYou.count > 0 ? (
          <button
            type="button"
            data-testid="board-needs-you-chip"
            onClick={needsYou.onReveal}
            aria-hidden={needsYou.offscreen ? undefined : true}
            tabIndex={needsYou.offscreen ? undefined : -1}
            className={[
              'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-amber/40 bg-amber/[0.08] px-2.5 text-[12px] font-medium text-foreground transition-[opacity,background-color] duration-150 hover:bg-amber/[0.14] focus-visible:outline-2 focus-visible:outline-offset-2',
              needsYou.offscreen ? '' : 'pointer-events-none invisible opacity-0',
            ].join(' ')}
          >
            <ShieldAlert size={13} strokeWidth={2} className="text-amber" aria-hidden />
            Needs you
            <RollingCount
              value={needsYou.count}
              className="font-data tabular-nums text-muted-foreground"
            />
          </button>
        ) : null}
        {range ? (
          <button
            type="button"
            data-testid="board-routines-toggle"
            aria-pressed={showRoutines}
            onClick={() => onShowRoutinesChange(!showRoutines)}
            title={showRoutines ? `Hide ${runWords}` : `Show ${runWords}`}
            className={[
              'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
              showRoutines
                ? 'border-border-strong bg-foreground/[0.06] text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            <Repeat size={13} strokeWidth={2.2} aria-hidden />
            Routines
            {/* The count is in the title too; the switch's name stays "Routines". */}
            {runTotal ? (
              <span
                aria-hidden
                data-testid="board-routines-count"
                className={[
                  'font-data ml-0.5 text-[11px] tabular-nums',
                  showRoutines ? 'text-foreground' : 'text-muted-foreground',
                ].join(' ')}
              >
                {runTotal}
              </span>
            ) : null}
          </button>
        ) : null}
        <SegmentedControl
          size="sm"
          aria-label="Board view"
          options={MODE_OPTIONS}
          value={mode}
          onChange={onModeChange}
        />
      </div>

      <span data-testid="board-calendar-announcer" className="sr-only" role="status">
        {announcement}
      </span>

      {pickerOpen && range && titleRef.current ? (
        <MiniMonth
          anchor={titleRef.current}
          range={range}
          now={now}
          weekStartsOn={weekStartsOn}
          activeDays={activeDays}
          onPick={(day) => {
            setPickerOpen(false)
            onPickDate(day)
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  )
}
