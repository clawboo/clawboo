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

/**
 * Whether a fire of this routine is starting or going now. The ticker sets the
 * next run from when a fire finishes, so while one is in flight the first run
 * drawn only happens if that fire has finished by then; otherwise it is skipped.
 */
export function routineInFlight(run: RoutineOccurrences): 'starting' | 'running' | null {
  const status = run.schedule.status
  if (status === 'queued') return 'starting'
  if (status === 'claimed' || status === 'running') return 'running'
  return null
}

/**
 * The routine's first run, or null when it has none. The Board hands over each
 * routine with the runs that have passed already removed, so this is the first
 * run still on the calendar.
 */
function firstRunOf(run: RoutineOccurrences): number | null {
  for (const w of run.windows) if (w.times[0] != null) return w.times[0]
  return null
}

/**
 * What a person reads about the run an in-flight fire may still skip. `at` names
 * it when the strip leads with a different time.
 */
function onlyIfFinished(run: RoutineOccurrences, at?: number): string {
  const now = routineInFlight(run) === 'starting' ? 'is starting now' : 'is running now'
  const which = at != null ? `the one at ${timeLabel(at)}` : 'this one'
  return `A run ${now}, so ${which} happens only if that run has finished by then.`
}

/** True when `at` is the run an in-flight fire may still skip. */
export function isConditionalRun(run: RoutineOccurrences, at: number | undefined): boolean {
  return at != null && routineInFlight(run) != null && at === firstRunOf(run)
}

/** "24 runs", or "288+ runs" when the day holds more than the server counted. */
function runCount(day: DayRuns<RoutineOccurrences>): string {
  return day.more ? `${day.count}+ runs` : countLabel(day.count, 'run')
}

/** The outlined Routine tag. Neutral on purpose: red marks today and nothing else. */
export function RoutineTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border-strong px-1.5 py-px text-micro font-medium text-muted-foreground">
      <Repeat size={10} strokeWidth={2} aria-hidden />
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
  nextAt,
  focusId,
  open,
  onOpen,
  line = false,
}: {
  day: DayRuns<RoutineOccurrences>
  /** The soonest run on screen, when this day holds it; null otherwise. */
  nextAt: number | null
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
  const isNext = nextAt != null
  // When the day's first run may be skipped, the next certain one later that day
  // is the time worth reading, so the strip leads with it and says which run is
  // in question.
  const shown = nextAt ?? first
  const leadsLater = shown != null && first != null && shown !== first
  const time = shown != null ? timeLabel(shown) : ''
  const firstTime = first != null ? timeLabel(first) : ''
  const cadence = describeCadence(day.routine.schedule.cronSpec)
  const many = day.count > 1
  const conditional = isConditionalRun(day.routine, first)
    ? onlyIfFinished(day.routine, leadsLater ? first : undefined)
    : null
  return (
    <button
      type="button"
      data-testid="calendar-routine-run"
      data-routine-id={day.routine.schedule.id}
      data-focus-restore-id={focusId}
      data-next={isNext || undefined}
      data-conditional={conditional ? true : undefined}
      data-open={open || undefined}
      onClick={(e) => onOpen(e.currentTarget)}
      title={conditional ?? undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Routine, ${name}, ${
        isNext ? (leadsLater ? `next run at ${time}, ` : 'next run, ') : ''
      }${many ? `${runCount(day)} from ${firstTime}` : firstTime}, ${cadence}. Upcoming.${
        conditional ? ` ${conditional}` : ''
      } ${
        routineKindOf(day.routine.schedule) === 'team'
          ? 'It posts to the team chat when it runs.'
          : 'It becomes a task when it runs.'
      }`}
      className={`calendar-run block w-full cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-offset-2 ${
        line ? 'px-2 py-[3px]' : 'px-2.5 py-1.5'
      }`}
    >
      {line ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Repeat size={12} strokeWidth={2} aria-hidden className="shrink-0" />
          <span className="shrink-0 tabular-nums">{time}</span>
          <span className="min-w-0 truncate font-medium">{name}</span>
          {many ? (
            <span className="ml-auto shrink-0 tabular-nums">{`×${day.more ? `${day.count}+` : day.count}`}</span>
          ) : null}
        </span>
      ) : (
        <>
          {/* The name has the whole width; when it runs, and how often that day, sit
          under it the way a card's details sit under its title. It is all in the
          muted ink: a run is planned, not work that exists. */}
          <span className="block truncate text-xs font-medium text-muted-foreground">{name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-micro text-muted-foreground">
            <Repeat size={12} strokeWidth={2} aria-hidden className="shrink-0" />
            <span className="shrink-0 tabular-nums">{time}</span>
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
  const inFlight = routineInFlight(run)

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
      className="surface-floating-tier board-pop-in board-ink-focus fixed z-[75] flex flex-col overflow-y-auto rounded-xl p-4 outline-none"
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
            className="truncate text-base font-semibold text-foreground"
            style={{ letterSpacing: '-0.01em' }}
          >
            {routineName(run)}
          </h2>
          <p className="mt-0.5 text-compact text-muted-foreground">
            {describeCadence(rec.cronSpec)}
            {zone ? `, ${zone} time` : ''}
          </p>
        </div>
        <RoutineTag />
      </div>

      <div className="mt-3.5 flex items-center gap-2 text-compact text-foreground">
        {team ? (
          <Users size={15} strokeWidth={2} className="shrink-0 text-muted-foreground" aria-hidden />
        ) : rec.agentId ? (
          <AgentBooAvatar agentId={rec.agentId} size={18} />
        ) : null}
        <span className="min-w-0 truncate">{targetSummary(rec)}</span>
      </div>

      {upcoming.length > 0 ? (
        <div className="mt-3.5">
          <div id={upcomingId} className="text-xs font-medium text-muted-foreground">
            Upcoming runs
          </div>
          {inFlight ? (
            <p
              data-testid="calendar-routine-in-flight"
              className="mt-1 text-xs text-muted-foreground"
            >
              {`A run ${inFlight === 'starting' ? 'is starting' : 'is running'} now. The first time below happens only if that run has finished by then; if not, it is skipped.`}
            </p>
          ) : null}
          <ul aria-labelledby={upcomingId} className="mt-1.5 flex flex-col gap-1">
            {upcoming.map((t) => (
              <li key={t} className="flex justify-between gap-3 text-xs text-foreground">
                <span className="tabular-nums">{shortDate(t)}</span>
                <span className="tabular-nums text-muted-foreground">{timeLabel(t)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3.5 text-xs leading-relaxed text-muted-foreground">{fireSummary(rec)}</p>

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
        <p id={blockedId} className="mt-2 text-right text-xs text-muted-foreground">
          {`Can’t run it now: ${blocked}.`}
        </p>
      ) : null}
    </div>,
    document.body,
  )
}
