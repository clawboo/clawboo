// The prompt a person sees when they finish a task by hand (Done or Cancelled),
// from a drag or the task drawer. Mounted once at the app root and driven by
// `askFinish()`.
//
// When the card sits on another day, it asks which day the task finished: today,
// the day it sits on, or another day picked from a small month. It also says what
// the move does when that is not obvious: a cancel cannot be undone, a running
// agent is stopped, a failed check is overridden. Escape or the scrim backs out,
// Enter confirms. Focus starts on the confirm button and returns to the opener.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CalendarDays, Check, ChevronLeft, ChevronRight } from 'lucide-react'

import { useFinishPromptStore, type FinishPromptRequest } from '@/stores/finishPrompt'
import { Button, IconButton } from '@/features/shared/Button'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { useFocusTrap } from '@/features/shared/useFocusTrap'

import { longDate, shortDate } from './calendar/calendarFormat'
import {
  addDays,
  dayKey,
  isSameDay,
  shiftFocus,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from './calendar/calendarModel'

type Option = 'today' | 'sits' | 'other'

/** The days a person may pick: from the day the task was added to today. */
function pickBounds(req: FinishPromptRequest): { min: number; max: number } {
  const max = startOfDay(req.now)
  const earliest = req.createdAt ?? req.sitsOn ?? req.now
  return { min: Math.min(startOfDay(earliest), max), max }
}

/** Whole days from `a` to `b`, by calendar date (DST-safe). */
function daysBetween(a: number, b: number): number {
  let n = 0
  for (let d = startOfDay(a); d < startOfDay(b) && n < 400; d = addDays(d, 1)) n++
  return n
}

function clampDay(day: number, min: number, max: number): number {
  return day < min ? min : day > max ? max : day
}

function FinishFocus({
  panelRef,
  okRef,
}: {
  panelRef: RefObject<HTMLDivElement | null>
  okRef: RefObject<HTMLButtonElement | null>
}) {
  useFocusTrap(panelRef, null, okRef)
  return null
}

export function FinishPromptDialog() {
  const open = useFinishPromptStore((s) => s.open)
  const request = useFinishPromptStore((s) => s.request)
  const settle = useFinishPromptStore((s) => s.settle)
  const scrimRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const okRef = useRef<HTMLButtonElement | null>(null)

  useDismissableLayer({
    active: open,
    level: 'dialog',
    onEscape: () => settle(null),
    contains: (target) => !!scrimRef.current?.contains(target),
    onPressOutside: () => undefined,
  })

  return (
    <>
      {open && request ? <FinishFocus panelRef={panelRef} okRef={okRef} /> : null}
      <AnimatePresence>
        {open && request ? (
          <motion.div
            key="finish-scrim"
            ref={scrimRef}
            className="fixed inset-0 z-[90] flex items-center justify-center p-4"
            style={{ background: 'var(--overlay-scrim)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) settle(null)
            }}
          >
            <FinishPanel
              // A new request starts from its own defaults.
              key={`${request.title}:${request.to}:${request.sitsOn ?? 'today'}`}
              request={request}
              panelRef={panelRef}
              okRef={okRef}
              onSettle={settle}
              active={open}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  )
}

function FinishPanel({
  request,
  panelRef,
  okRef,
  onSettle,
  active,
}: {
  request: FinishPromptRequest
  panelRef: RefObject<HTMLDivElement | null>
  okRef: RefObject<HTMLButtonElement | null>
  onSettle: (choice: { day: number } | null) => void
  active: boolean
}) {
  const headingId = useId()
  const groupLabelId = useId()
  const today = startOfDay(request.now)
  const bounds = useMemo(() => pickBounds(request), [request])
  const sits = request.sitsOn
  // "Another day" is worth offering only when a day exists besides today and the
  // day the card sits on.
  const offerOther = sits != null && daysBetween(bounds.min, bounds.max) >= 2
  const [option, setOption] = useState<Option>('today')
  const [otherDay, setOtherDay] = useState(() =>
    clampDay(sits != null ? addDays(sits, 1) : today, bounds.min, addDays(bounds.max, -1)),
  )
  const chosenDay = option === 'today' ? today : option === 'sits' && sits != null ? sits : otherDay

  const confirm = () => onSettle({ day: chosenDay })

  // Enter confirms, unless something nearer the target used it (the little
  // calendar picks a day with it).
  useEffect(() => {
    if (!active) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return
      e.preventDefault()
      onSettle({ day: chosenDay })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, chosenDay, onSettle])

  const cancelling = request.to === 'cancelled'
  const overriding = !cancelling && request.failedCheck
  const title = request.title.trim() || 'this task'
  const heading = cancelling
    ? `Cancel “${title}”?`
    : overriding
      ? `Complete “${title}” anyway?`
      : `Mark “${title}” done`
  const notes: string[] = []
  if (cancelling) notes.push('It moves to Cancelled and will not run again.')
  if (request.runningAgent)
    notes.push(`${request.runningAgent} is still working on it. This stops that run.`)
  if (overriding)
    notes.push('Its check didn’t pass. Completing it anyway is recorded in the audit log.')

  const options: Array<{ id: Option; label: string; aside: string }> = [
    { id: 'today', label: 'Today', aside: shortDate(today) },
  ]
  if (sits != null) {
    options.push({ id: 'sits', label: shortDate(sits), aside: 'The day it’s on now' })
    if (offerOther)
      options.push({
        id: 'other',
        label: 'Another day',
        aside: option === 'other' ? shortDate(otherDay) : 'Pick from a calendar',
      })
  }

  function onOptionKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0
    if (!step) return
    e.preventDefault()
    const next = options[(index + step + options.length) % options.length]!
    setOption(next.id)
    const group = e.currentTarget.parentElement
    group?.querySelector<HTMLButtonElement>(`[data-option="${next.id}"]`)?.focus()
  }

  return (
    <motion.div
      ref={panelRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={headingId}
      data-testid="finish-prompt"
      data-to={request.to}
      className="surface-overlay-tier board-ink-focus w-full max-w-[400px] rounded-2xl p-5"
      initial={{ opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 6 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
    >
      <h2
        id={headingId}
        className="line-clamp-2 text-[15px] font-semibold text-foreground"
        style={{ letterSpacing: '-0.01em' }}
      >
        {heading}
      </h2>
      {notes.map((n) => (
        <p key={n} className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {n}
        </p>
      ))}

      {sits != null ? (
        <div className="mt-4">
          <p
            id={groupLabelId}
            className="board-micro mb-1.5 text-[11px] font-semibold text-muted-foreground"
          >
            {cancelling ? 'Put it on' : 'Finished on'}
          </p>
          <div
            role="radiogroup"
            aria-labelledby={groupLabelId}
            data-testid="finish-day-options"
            className="flex flex-col gap-1"
          >
            {options.map((o, i) => {
              const checked = option === o.id
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-option={o.id}
                  data-testid={`finish-day-${o.id}`}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setOption(o.id)}
                  onKeyDown={(e) => onOptionKey(e, i)}
                  className={[
                    'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
                    checked
                      ? 'border-foreground/25 bg-foreground/[0.05]'
                      : 'border-border hover:bg-foreground/[0.03]',
                  ].join(' ')}
                >
                  <span
                    aria-hidden
                    className={[
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      checked
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border-strong',
                    ].join(' ')}
                  >
                    {checked ? <Check size={10} strokeWidth={3} /> : null}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-foreground">
                    {o.id === 'other' ? (
                      <CalendarDays
                        size={13}
                        strokeWidth={2}
                        aria-hidden
                        className="text-muted-foreground"
                      />
                    ) : null}
                    {o.label}
                  </span>
                  <span className="ml-auto truncate text-[12px] text-muted-foreground">
                    {o.aside}
                  </span>
                </button>
              )
            })}
          </div>
          {option === 'other' ? (
            <DayPicker
              min={bounds.min}
              // Today and the card's own day have options of their own.
              max={addDays(bounds.max, -1)}
              value={otherDay}
              onChange={setOtherDay}
              weekStartsOn={request.weekStartsOn}
              today={today}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onSettle(null)}
          data-testid="finish-cancel"
        >
          Keep it
        </Button>
        <Button
          ref={okRef}
          variant={cancelling || overriding ? 'danger' : 'solid'}
          size="sm"
          onClick={confirm}
          data-testid="finish-ok"
        >
          {cancelling ? 'Cancel task' : overriding ? 'Complete anyway' : 'Mark done'}
        </Button>
      </div>
    </motion.div>
  )
}

/** A small month for picking a day between `min` and `max`. Arrows move a day or
 *  a week, Page Up and Page Down a month, Enter or Space picks. */
function DayPicker({
  min,
  max,
  value,
  onChange,
  weekStartsOn,
  today,
}: {
  min: number
  max: number
  value: number
  onChange: (day: number) => void
  weekStartsOn: number
  today: number
}) {
  const headingId = useId()
  const gridRef = useRef<HTMLTableElement>(null)
  const [cursor, setCursor] = useState(value)
  const month = startOfMonth(cursor)
  const weeks = useMemo(() => {
    const first = startOfWeek(month, weekStartsOn)
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)),
    )
  }, [month, weekStartsOn])
  const heads = weeks[0]!.map((d) => ({
    short: new Date(d).toLocaleDateString(undefined, { weekday: 'narrow' }),
    long: new Date(d).toLocaleDateString(undefined, { weekday: 'long' }),
  }))
  const focusRef = useRef(false)
  useEffect(() => {
    if (!focusRef.current) return
    focusRef.current = false
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-day="${dayKey(cursor)}"]`)
      ?.focus()
  }, [cursor])

  const canPrev = startOfMonth(min) < month
  const canNext = startOfMonth(max) > month

  function onKey(e: KeyboardEvent<HTMLTableElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onChange(cursor)
      return
    }
    const move: Record<string, () => number> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      PageUp: () => shiftFocus('month', cursor, -1),
      PageDown: () => shiftFocus('month', cursor, 1),
    }
    const next = move[e.key]
    if (!next) return
    e.preventDefault()
    const to = clampDay(next(), min, max)
    if (to === cursor) return
    focusRef.current = true
    setCursor(to)
    onChange(to)
  }

  const monthLabel = new Date(month).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  return (
    <div data-testid="finish-day-picker" className="mt-2 rounded-xl border border-border p-2.5">
      <div className="mb-1.5 flex items-center justify-between pl-1">
        <span id={headingId} className="text-[13px] font-semibold text-foreground">
          {monthLabel}
        </span>
        <span className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label="Previous month"
            disabled={!canPrev}
            onClick={() => setCursor((c) => clampDay(shiftFocus('month', c, -1), min, max))}
          >
            <ChevronLeft size={15} strokeWidth={2} />
          </IconButton>
          <IconButton
            size="sm"
            label="Next month"
            disabled={!canNext}
            onClick={() => setCursor((c) => clampDay(shiftFocus('month', c, 1), min, max))}
          >
            <ChevronRight size={15} strokeWidth={2} />
          </IconButton>
        </span>
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-labelledby={headingId}
        onKeyDown={onKey}
        className="w-full border-separate"
        style={{ borderSpacing: '0 1px' }}
      >
        <thead>
          <tr>
            {heads.map((h, i) => (
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
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const inMonth = new Date(d).getMonth() === new Date(month).getMonth()
                const allowed = d >= min && d <= max
                const picked = isSameDay(d, value)
                const isToday = isSameDay(d, today)
                return (
                  <td key={d} role="gridcell" aria-selected={picked} className="p-0">
                    <button
                      type="button"
                      data-day={dayKey(d)}
                      tabIndex={isSameDay(d, cursor) ? 0 : -1}
                      disabled={!allowed}
                      aria-label={`${longDate(d)}${isToday ? ', today' : ''}`}
                      onClick={() => {
                        setCursor(d)
                        onChange(d)
                      }}
                      className={[
                        'mx-auto flex h-7 w-7 items-center justify-center rounded-full text-[12px] tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1',
                        allowed ? 'cursor-pointer hover:bg-foreground/[0.08]' : 'cursor-default',
                        picked
                          ? 'bg-foreground font-semibold text-background hover:bg-foreground'
                          : allowed
                            ? inMonth
                              ? 'text-foreground'
                              : 'text-muted-foreground'
                            : 'text-muted-foreground/40',
                      ].join(' ')}
                    >
                      {new Date(d).getDate()}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
