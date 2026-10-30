// The board's second bar, 48px like the first. On the calendar views it holds
// back, home and forward beside the range title (which opens the date picker);
// the board's controls (Find, Filter, Display, the view) sit on the right. While
// today is off screen, the Today button points the way to it. The Today view is
// today alone, so it has nothing to page through.
// Keyboard: T for today, the left and right arrows for the previous and next
// range.

import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react'

import { TOOLBAR_BUTTON } from '../BoardToolbar'
import { rangeRelation, rangeTitle } from './calendarFormat'
import type { CalendarMode, CalendarRange } from './calendarModel'
import { MiniMonth } from './MiniMonth'

/** The chevrons beside the range: round ghost buttons, 28px. */
const STEP_BUTTON =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2'

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

export interface CalendarToolbarProps {
  mode: CalendarMode
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
  /** The board's controls, on the right. */
  actions: ReactNode
  /** What the polite live region last said about a range change. */
  announcement: string
}

export function CalendarToolbar(props: CalendarToolbarProps) {
  const {
    mode,
    range,
    now,
    weekStartsOn,
    activeDays,
    onPrev,
    onNext,
    onToday,
    todayDirection,
    onPickDate,
    actions,
    announcement,
  } = props
  const titleRef = useRef<HTMLButtonElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const todayAngle = useTodayAngle(todayDirection)
  const unit = mode === 'month' ? 'month' : 'week'
  const title = range ? rangeTitle(range) : null
  const pages = range != null && range.mode !== 'day'
  // The Today view's relation would only repeat its name.
  const relation = pages ? rangeRelation(range, now) : null

  return (
    <div
      data-testid="board-calendar-toolbar"
      className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1"
    >
      {range && title ? (
        <div className="flex min-w-0 items-center gap-1">
          {pages ? (
            <>
              <button
                type="button"
                onClick={onToday}
                // "Today" is also a view; this one goes there.
                aria-label="Go to today"
                title={
                  todayDirection ? `Today is ${TODAY_WHERE[todayDirection]} (T)` : 'Go to today (T)'
                }
                className={`${TOOLBAR_BUTTON} mr-1 border-border pr-2 text-foreground hover:bg-foreground/[0.04]`}
              >
                Today
                {/* Points the way to today while it is off screen. The slot is always
                there, so the button keeps its width as the chevron comes and goes. */}
                <ChevronUp
                  size={12}
                  strokeWidth={2}
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
              <button
                type="button"
                aria-label={`Previous ${unit} (Left arrow)`}
                title={`Previous ${unit} (Left arrow)`}
                onClick={onPrev}
                className={STEP_BUTTON}
              >
                <ChevronLeft size={16} strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Next ${unit} (Right arrow)`}
                title={`Next ${unit} (Right arrow)`}
                onClick={onNext}
                className={STEP_BUTTON}
              >
                <ChevronRight size={16} strokeWidth={2} aria-hidden />
              </button>
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
            className="group ml-1 inline-flex min-w-0 cursor-pointer items-baseline gap-1.5 rounded-lg px-2 py-0.5 transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {/* "Oct 11 to 17, 2026" in a week, "October 2026" in a month. */}
            <span className="truncate text-base font-semibold tabular-nums text-foreground">
              {title.dates}
              {range.mode !== 'month' && title.year ? ',' : null}
            </span>
            {/* The gap is drawn by the flex gap; this space is for the button's name. */}{' '}
            {title.year ? (
              <span className="text-base font-normal tabular-nums text-muted-foreground">
                {title.year}
              </span>
            ) : null}
            <ChevronDown
              size={14}
              strokeWidth={2}
              className="self-center text-muted-foreground transition-transform group-aria-expanded:rotate-180"
              aria-hidden
            />
          </button>
          {relation ? (
            <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">{relation}</span>
          ) : null}
        </div>
      ) : (
        // The Kanban board has no dates to page through. The column heads count
        // the tasks, so the bar does not.
        <span className="text-xs text-muted-foreground">Every task by status, newest first</span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>

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
