// The small parts Home is built from: a section with its heading, the health dot,
// the progress bar, a KPI's source badge and stale mark, and a team's mark.

import type { ReactNode } from 'react'
import { AlertCircle, Bot, Calculator, UserRound } from 'lucide-react'

import type { GoalHealth, KpiTile } from '@clawboo/control-client'

import { SECTION_LABEL } from '@/features/shared/sectionLabel'

import { healthColor, healthLabel, staleWords } from './homeFormat'

/** A Home section: a heading row (title, an optional count and action) over
 *  its content. `id` names it for the heading's aria link. */
export function HomeSection({
  id,
  title,
  count,
  action,
  children,
  testId,
}: {
  id: string
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
  testId?: string
}) {
  const headingId = `home-section-${id}`
  return (
    <section aria-labelledby={headingId} data-testid={testId ?? `home-section-${id}`}>
      <div className="mb-2 flex min-h-7 items-center gap-2">
        <h2 id={headingId} className={`${SECTION_LABEL} m-0`}>
          {title}
        </h2>
        {count !== undefined ? (
          <span className="font-mono text-micro tabular-nums text-muted-foreground">{count}</span>
        ) : null}
        {action ? <span className="ml-auto flex items-center gap-1">{action}</span> : null}
      </div>
      {children}
    </section>
  )
}

/** A card in normal flow. */
export const HOME_CARD = 'rounded-xl border border-border bg-surface'

/** A clickable row inside a card list. */
export const HOME_ROW =
  'flex w-full min-w-0 cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2'

/** A small text button in a section's heading row. */
export const HEADING_ACTION =
  'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2'

/** A goal's health as a dot, with its words for a screen reader. `decorative`
 *  when its words are already written beside it, so they are not read twice. */
export function HealthDot({
  health,
  size = 10,
  decorative = false,
}: {
  health: GoalHealth | null
  size?: number
  decorative?: boolean
}) {
  return (
    <span
      aria-hidden={decorative || undefined}
      className="inline-block shrink-0 rounded-full"
      title={healthLabel(health)}
      style={{
        width: size,
        height: size,
        background: health ? healthColor(health) : 'transparent',
        border: health ? 'none' : `1.5px solid ${healthColor(null)}`,
      }}
    >
      {decorative ? null : <span className="sr-only">{healthLabel(health)}</span>}
    </span>
  )
}

/** A thin bar, 0 to 100. `faded` dims it (a goal whose update is missing). */
export function ProgressBar({
  percent,
  color = 'var(--mint)',
  faded = false,
  label,
}: {
  percent: number
  color?: string
  faded?: boolean
  label: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="relative block h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
        style={{ width: `${clamped}%`, background: color, opacity: faded ? 0.45 : 1 }}
      />
    </span>
  )
}

/** Where a KPI's value came from: computed, an agent (by name) or a person. */
export function SourceBadge({ tile, text }: { tile: KpiTile; text: string }) {
  const source = tile.reading.source
  const Icon = source === 'computed' ? Calculator : source === 'agent' ? Bot : UserRound
  return (
    <span
      data-testid="kpi-source"
      className="inline-flex h-5 max-w-full items-center gap-1 rounded-md border border-border px-1.5 text-micro font-medium text-muted-foreground"
    >
      <Icon size={11} strokeWidth={2} aria-hidden className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  )
}

/** The mark a stale KPI value carries. */
export function StaleMark({ tile, now }: { tile: KpiTile; now: number }) {
  const words = staleWords(tile, now)
  if (!words) return null
  return (
    <span
      data-testid="kpi-stale"
      title={words}
      className="board-reason inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-micro font-semibold uppercase tracking-wide"
      style={{ background: 'rgb(var(--amber-rgb) / 0.1)' }}
    >
      <AlertCircle size={11} strokeWidth={2.25} aria-hidden />
      Stale
      <span className="sr-only">{`. ${words}`}</span>
    </span>
  )
}

/** A team's icon on a small tile in its color. */
export function TeamMark({
  icon,
  color,
  size = 24,
}: {
  icon: string | null
  color: string | null
  size?: number
}) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-lg"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.58),
        background: color
          ? `color-mix(in srgb, ${color} 18%, transparent)`
          : 'rgb(var(--foreground-rgb) / 0.06)',
      }}
    >
      {icon || '•'}
    </span>
  )
}

/** A headline number with what it counts, for the All teams totals. */
export function Stat({
  label,
  value,
  note,
  testId,
}: {
  label: string
  value: string
  note?: string
  testId?: string
}) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </div>
      {note ? <div className="text-micro text-muted-foreground">{note}</div> : null}
    </div>
  )
}
