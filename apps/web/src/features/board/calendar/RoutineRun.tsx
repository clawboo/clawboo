// A routine's upcoming runs on one day, drawn in the To do column, and the
// popover that opens from it. A run is a projection, not a task: it has a
// pencil hatch and a dashed edge instead of a card's surface, a repeat mark, no
// status and no drag handle, so nobody mistakes it for work that already exists.
// When the routine fires, an agent routine becomes a real task card on that
// same day.

import { useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Repeat, Users } from 'lucide-react'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { Button } from '@/features/shared/Button'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'
import { useFocusTrap } from '@/features/shared/useFocusTrap'
import {
  describeCadence,
  fireSummary,
  routineKindOf,
  runNowBlocker,
  targetSummary,
} from '@/features/routines/routineHelpers'
import type { RoutineOccurrences } from '@/lib/schedulesClient'

import { countLabel, shortDate, timeLabel } from './calendarFormat'
import type { DayRuns } from './calendarModel'
import { useAnchoredPosition } from './useAnchoredPosition'

export function routineName(run: RoutineOccurrences): string {
  const s = run.schedule
  return s.label || s.agentName || 'Routine'
}

/** "24 runs", or "288+ runs" when the day holds more than the server counted. */
function runCount(day: DayRuns<RoutineOccurrences>): string {
  return day.more ? `${day.count}+ runs` : countLabel(day.count, 'run')
}

/** The outlined Routine tag. Neutral on purpose: red marks today and nothing else. */
export function RoutineTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-[5px] border border-border-strong px-1.5 py-px text-[10px] font-medium leading-4 text-muted-foreground">
      <Repeat size={10} strokeWidth={2.4} aria-hidden />
      Routine
    </span>
  )
}

/**
 * One routine's runs on one day: the name on its own line, the repeat mark,
 * time and run count under it. As one line (the mark, the time, the name) it
 * fills a thin row (a day with nothing on it but routine runs), and on any other
 * day stands for every run but today's and the next.
 */
export function RoutineRunStrip({
  day,
  isNext,
  accent,
  focusId,
  open,
  onOpen,
  line = false,
}: {
  day: DayRuns<RoutineOccurrences>
  /** This day holds the soonest run on screen. */
  isNext: boolean
  /** The column's colour, as a CSS colour. */
  accent: string
  /** Lets the popover hand focus back to this strip if a re-render replaced it. */
  focusId: string
  /** Its popover is open. */
  open: boolean
  onOpen: (anchor: HTMLElement) => void
  /** Draw it on one line, for a day row folded down to its runs. */
  line?: boolean
}) {
  const name = routineName(day.routine)
  const first = day.times[0]
  const time = first != null ? timeLabel(first) : ''
  const cadence = describeCadence(day.routine.schedule.cronSpec)
  const many = day.count > 1
  return (
    <button
      type="button"
      data-testid="calendar-routine-run"
      data-routine-id={day.routine.schedule.id}
      data-focus-restore-id={focusId}
      data-next={isNext || undefined}
      data-open={open || undefined}
      onClick={(e) => onOpen(e.currentTarget)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Routine, ${name}, ${isNext ? 'next run, ' : ''}${
        many ? `${runCount(day)} from ${time}` : time
      }, ${cadence}. Upcoming. ${
        routineKindOf(day.routine.schedule) === 'team'
          ? 'It posts to the team chat when it runs.'
          : 'It becomes a task when it runs.'
      }`}
      className={`calendar-run block w-full cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 ${
        line ? 'px-2 py-[3px]' : 'px-2.5 py-1.5'
      }`}
      style={{ '--chip': accent } as CSSProperties}
    >
      {line ? (
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-foreground">
          <Repeat
            size={11}
            strokeWidth={2.4}
            aria-hidden
            className="shrink-0"
            style={{ color: accent }}
          />
          {isNext ? (
            <span
              aria-hidden
              className="size-[5px] shrink-0 rounded-full"
              style={{ background: accent }}
            />
          ) : null}
          <span className="font-data shrink-0 tabular-nums">{time}</span>
          <span className="min-w-0 truncate font-semibold">{name}</span>
          {many ? (
            <span className="ml-auto shrink-0 tabular-nums">{`×${day.more ? `${day.count}+` : day.count}`}</span>
          ) : null}
        </span>
      ) : (
        <>
          {/* The name has the whole width; when it runs, and how often that day, sit
          under it the way a card's details sit under its title. Size and weight
          set the two lines apart, and both stay the foreground colour: the hatch
          crosses every glyph of the second line, and muted text over its lines
          falls under 4.5:1. */}
          <span className="block truncate text-[12.5px] font-semibold leading-[18px] text-foreground">
            {name}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-[14px] text-foreground">
            <Repeat
              size={11}
              strokeWidth={2.4}
              aria-hidden
              className="shrink-0"
              style={{ color: accent }}
            />
            {isNext ? (
              <span
                aria-hidden
                className="size-[5px] shrink-0 rounded-full"
                style={{ background: accent }}
              />
            ) : null}
            <span className="font-data shrink-0 tabular-nums">{time}</span>
            {many ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate tabular-nums">{runCount(day)}</span>
              </>
            ) : null}
          </span>
        </>
      )}
    </button>
  )
}

/** "New York" from "America/New_York": how a person names a zone. */
function zoneLabel(timeZone: string): string {
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ')
}

/** The browser's own zone, when the engine can say. */
function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null
  } catch {
    return null
  }
}

const POPOVER_W = 320

export function RoutineRunPopover({
  run,
  anchor,
  now,
  timeZone,
  onClose,
  onRunNow,
  onOpenRoutine,
}: {
  run: RoutineOccurrences
  anchor: HTMLElement
  now: number
  /** The zone the scheduler fires in; named when it is not the browser's. */
  timeZone: string | null
  onClose: () => void
  onRunNow: () => Promise<void>
  onOpenRoutine: () => void
}) {
  const headingId = useId()
  const blockedId = useId()
  const upcomingId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const pos = useAnchoredPosition(anchor, true, POPOVER_W, 380)
  const rec = run.schedule
  const team = routineKindOf(rec) === 'team'
  const blocked = runNowBlocker(rec)
  const upcoming = run.windows
    .flatMap((w) => w.times)
    .filter((t) => t > now)
    .slice(0, 5)

  useDismissableLayer({
    active: true,
    level: 'popover',
    onEscape: onClose,
    contains: (t) => !!panelRef.current?.contains(t) || anchor.contains(t),
    onPressOutside: onClose,
  })

  // Focus moves into the popover once it is placed (its first frame renders
  // nothing), stays inside while it is open, and returns to the run it opened
  // from when it closes.
  const placed = pos != null
  useFocusTrap(panelRef, placed, panelRef)
  const zone = timeZone && timeZone !== browserZone() ? zoneLabel(timeZone) : null

  if (!pos) return null
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      data-testid="calendar-routine-popover"
      tabIndex={-1}
      className="surface-floating-tier board-pop-in board-ink-focus fixed z-[75] flex flex-col overflow-y-auto rounded-2xl p-4 outline-none"
      style={
        {
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          width: POPOVER_W,
          maxHeight: pos.maxHeight,
          // It grows from the run it opened from: down from a run above it, up
          // from a run below it.
          '--pop-origin': pos.top != null ? 'top left' : 'bottom left',
          '--pop-dy': pos.top != null ? '4px' : '-4px',
        } as CSSProperties
      }
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'rgb(var(--foreground-rgb) / 0.06)' }}
        >
          <Repeat size={17} strokeWidth={2} className="text-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            className="truncate text-[15px] font-semibold text-foreground"
            style={{ letterSpacing: '-0.01em' }}
          >
            {routineName(run)}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {describeCadence(rec.cronSpec)}
            {zone ? `, ${zone} time` : ''}
          </p>
        </div>
        <RoutineTag />
      </div>

      <div className="mt-3.5 flex items-center gap-2 text-[12.5px] text-foreground">
        {team ? (
          <Users size={15} strokeWidth={2} className="shrink-0 text-muted-foreground" aria-hidden />
        ) : rec.agentId ? (
          <AgentBooAvatar agentId={rec.agentId} size={18} />
        ) : null}
        <span className="min-w-0 truncate">{targetSummary(rec)}</span>
      </div>

      {upcoming.length > 0 ? (
        <div className="mt-3.5">
          <div id={upcomingId} className="text-[11px] font-semibold text-muted-foreground">
            Upcoming runs
          </div>
          <ul aria-labelledby={upcomingId} className="mt-1.5 flex flex-col gap-1">
            {upcoming.map((t) => (
              <li key={t} className="flex justify-between gap-3 text-[12px] text-foreground">
                <span className="tabular-nums">{shortDate(t)}</span>
                <span className="font-data tabular-nums text-muted-foreground">{timeLabel(t)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3.5 text-[12px] leading-relaxed text-muted-foreground">{fireSummary(rec)}</p>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          disabled={!!blocked}
          aria-describedby={blocked ? blockedId : undefined}
          onClick={() => {
            setBusy(true)
            void onRunNow().finally(() => setBusy(false))
          }}
        >
          Run now
        </Button>
        <Button size="sm" variant="secondary" onClick={onOpenRoutine}>
          Open routine
        </Button>
      </div>
      {blocked ? (
        <p id={blockedId} className="mt-2 text-right text-[11.5px] text-muted-foreground">
          {`Can’t run it now: ${blocked}.`}
        </p>
      ) : null}
    </div>,
    document.body,
  )
}
