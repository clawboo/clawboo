// The date picker that opens from the calendar's range title: one month at a
// time, the range on screen drawn as a band, today ringed, and a dot under every
// day that holds work. Picking a day jumps the board to the week or month holding
// it. Keyboard: arrows move a day or a week, Page Up and Page Down a month, Home
// and End the ends of the week, Enter picks, Escape closes.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { IconButton } from '@/features/shared/Button'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { useFocusTrap } from '@/features/shared/useFocusTrap'

import { isoWeek, longDate } from './calendarFormat'
import {
  addDays,
  dayKey,
  isSameDay,
  shiftFocus,
  startOfDay,
  startOfMonth,
  startOfWeek,
  type CalendarRange,
} from './calendarModel'
import { useAnchoredPosition } from './useAnchoredPosition'

const WIDTH = 296

export function MiniMonth({
  anchor,
  range,
  now,
  weekStartsOn,
  activeDays,
  onPick,
  onClose,
}: {
  anchor: HTMLElement
  range: CalendarRange
  now: number
  weekStartsOn: number
  /** Day keys that hold at least one task. */
  activeDays: ReadonlySet<string>
  onPick: (day: number) => void
  onClose: () => void
}) {
  const headingId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLTableElement>(null)
  const pos = useAnchoredPosition(anchor, true, WIDTH, 360)
  const initial = range.start <= now && now < range.end ? startOfDay(now) : range.start
  const [cursor, setCursor] = useState(initial)
  const month = startOfMonth(cursor)
  // Which way the month last paged, so its day grid slides in from that side.
  // Null until it pages, so the picker opens without a slide.
  const [paged, setPaged] = useState<{ month: number; dir: 'next' | 'prev' | null }>({
    month,
    dir: null,
  })
  if (paged.month !== month) setPaged({ month, dir: month > paged.month ? 'next' : 'prev' })

  useDismissableLayer({
    active: true,
    level: 'popover',
    onEscape: onClose,
    contains: (t) => !!panelRef.current?.contains(t) || anchor.contains(t),
    onPressOutside: onClose,
  })

  // Six weeks always, so the popover never changes height between months.
  const weeks = useMemo(() => {
    const first = startOfWeek(month, weekStartsOn)
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)),
    )
  }, [month, weekStartsOn])

  const weekdayHeads = weeks[0]!.map((d) => ({
    short: new Date(d).toLocaleDateString(undefined, { weekday: 'narrow' }),
    long: new Date(d).toLocaleDateString(undefined, { weekday: 'long' }),
  }))

  // Keyboard focus starts on the cursor day when the picker opens and follows it
  // while the arrows move it. A key arms the flag only when it moves the cursor:
  // a key that leaves the cursor in place renders nothing, so this would not run
  // to clear it. The month buttons move the cursor too and disarm the flag first,
  // so focus stays on the button pressed. The first frame has no position yet
  // and renders nothing, so this also waits for the panel to be placed. A step
  // across a month edge remounts the day rows (they are keyed by month, for the
  // slide), and this runs after that commit, so it finds the cursor day in the
  // new rows.
  const placed = pos != null
  const focusDayRef = useRef(true)
  useEffect(() => {
    if (!placed || !focusDayRef.current) return
    focusDayRef.current = false
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-day="${dayKey(cursor)}"]`)
      ?.focus()
  }, [cursor, placed])
  // After the effect above, so the trap finds focus already inside and leaves it.
  // It keeps Tab inside and hands focus back to the range title on close.
  useFocusTrap(panelRef, placed)

  function onGridKey(e: KeyboardEvent<HTMLTableElement>) {
    const move: Record<string, () => number> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      PageUp: () => shiftFocus('month', cursor, -1),
      PageDown: () => shiftFocus('month', cursor, 1),
      Home: () => startOfWeek(cursor, weekStartsOn),
      End: () => addDays(startOfWeek(cursor, weekStartsOn), 6),
    }
    const next = move[e.key]
    if (!next) return
    e.preventDefault()
    let to = next()
    // A month step lands on the same day number where the month has it.
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      const want = new Date(cursor).getDate()
      const d = new Date(to)
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      d.setDate(Math.min(want, last))
      to = d.getTime()
    }
    // Home on the week's first day, or End on its last, leaves focus where it is.
    if (to !== cursor) focusDayRef.current = true
    setCursor(to)
  }

  if (!pos) return null
  const monthLabel = new Date(month).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      data-testid="calendar-mini-month"
      className="surface-floating-tier board-pop-in board-ink-focus fixed z-[75] rounded-2xl p-3"
      style={
        {
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          width: WIDTH,
          // It grows from the corner nearest the range title: its top when it
          // opens below the title, its bottom when it opens above.
          '--pop-origin': pos.top != null ? 'top left' : 'bottom left',
          '--pop-dy': pos.top != null ? '4px' : '-4px',
        } as CSSProperties
      }
    >
      <div className="mb-2 flex items-center justify-between pl-1.5">
        <h2
          id={headingId}
          className="font-display font-display-cut text-[14px] font-semibold text-foreground"
        >
          {monthLabel}
        </h2>
        <span className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label="Previous month"
            onClick={() => {
              focusDayRef.current = false
              setCursor((c) => shiftFocus('month', c, -1))
            }}
          >
            <ChevronLeft size={15} strokeWidth={2} />
          </IconButton>
          <IconButton
            size="sm"
            label="Next month"
            onClick={() => {
              focusDayRef.current = false
              setCursor((c) => shiftFocus('month', c, 1))
            }}
          >
            <ChevronRight size={15} strokeWidth={2} />
          </IconButton>
        </span>
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-labelledby={headingId}
        onKeyDown={onGridKey}
        className="w-full border-separate"
        style={{ borderSpacing: '0 2px' }}
      >
        <thead>
          <tr>
            <th scope="col" className="w-7">
              <span className="sr-only">Week</span>
            </th>
            {weekdayHeads.map((h, i) => (
              <th
                key={i}
                scope="col"
                abbr={h.long}
                className="pb-1 text-center text-[10.5px] font-semibold text-muted-foreground"
              >
                {h.short}
              </th>
            ))}
          </tr>
        </thead>
        {/* Keyed by month: a new month mounts fresh rows, and those slide in
            from the side the month came from. Enter only, nothing leaves. */}
        <tbody key={month} className={paged.dir ? `board-month-in-${paged.dir}` : undefined}>
          {weeks.map((week) => {
            return (
              <tr key={week[0]}>
                <th
                  scope="row"
                  className="pr-1 text-center text-[10px] font-normal tabular-nums text-muted-foreground"
                >
                  <span className="sr-only">Week </span>
                  {/* Mid-week decides it, so a Sunday-first row is not labelled
                      with the ISO week that ended on its first day. */}
                  {isoWeek(week[3]!)}
                </th>
                {week.map((d, i) => {
                  const inMonth = new Date(d).getMonth() === new Date(month).getMonth()
                  const inRange = d >= range.start && d < range.end
                  const today = isSameDay(d, now)
                  const focused = isSameDay(d, cursor)
                  const active = activeDays.has(dayKey(d))
                  const first = i === 0 || !(addDays(d, -1) >= range.start)
                  const last = i === 6 || !(addDays(d, 1) < range.end)
                  return (
                    <td
                      key={d}
                      role="gridcell"
                      aria-selected={inRange}
                      className="p-0"
                      style={{
                        background: inRange ? 'rgb(var(--foreground-rgb) / 0.07)' : undefined,
                        borderTopLeftRadius: inRange && first ? 9 : 0,
                        borderBottomLeftRadius: inRange && first ? 9 : 0,
                        borderTopRightRadius: inRange && last ? 9 : 0,
                        borderBottomRightRadius: inRange && last ? 9 : 0,
                      }}
                    >
                      <button
                        type="button"
                        data-day={dayKey(d)}
                        tabIndex={focused ? 0 : -1}
                        aria-label={`${longDate(d)}${today ? ', today' : ''}${active ? ', has tasks' : ''}`}
                        aria-current={today ? 'date' : undefined}
                        onClick={() => onPick(d)}
                        className={[
                          'relative mx-auto flex h-8 w-8 cursor-pointer flex-col items-center justify-center rounded-full text-[12.5px] tabular-nums transition-colors hover:bg-foreground/[0.08] focus-visible:outline-2 focus-visible:outline-offset-1',
                          inMonth ? 'text-foreground' : 'text-muted-foreground',
                          today ? 'font-semibold' : '',
                        ].join(' ')}
                        style={
                          today ? { boxShadow: 'inset 0 0 0 1.5px var(--primary)' } : undefined
                        }
                      >
                        {new Date(d).getDate()}
                        {active ? (
                          <span
                            aria-hidden
                            className="absolute bottom-1 h-1 w-1 rounded-full bg-foreground/45"
                          />
                        ) : null}
                      </button>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => onPick(now)}
          className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Go to today
        </button>
      </div>
    </div>,
    document.body,
  )
}
