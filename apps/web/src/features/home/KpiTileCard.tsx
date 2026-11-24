// One KPI as a tile: its value in its unit, the target and which way is good, the
// window it reads, a bar toward the target, and where the value came from (a
// source badge naming the agent or person, and when). A value older than its KPI
// allows carries a stale mark. Clicking it opens the KPI.

import { ArrowDown, ArrowUp } from 'lucide-react'

import type { KpiTile } from '@clawboo/control-client'

import {
  kpiWindow,
  meetsTarget,
  provenanceWords,
  readingText,
  relativeTime,
  sourceBadge,
  targetPercent,
  targetWords,
} from './homeFormat'
import { ProgressBar, SourceBadge, StaleMark } from './homeParts'
import type { HomeNames } from './useHomeNames'

export function KpiTileCard({
  tile,
  now,
  names,
  onOpen,
  compact = false,
}: {
  tile: KpiTile
  now: number
  names: HomeNames
  onOpen?: (tile: KpiTile) => void
  /** The All teams card's smaller tile: no bar, no badge row. */
  compact?: boolean
}) {
  const { kpi, reading } = tile
  const value = readingText(reading, kpi.unit)
  const target = targetWords(kpi)
  const meets = meetsTarget(tile)
  const percent = targetPercent(tile)
  const provenance = provenanceWords(tile, now, names)
  const DirIcon = kpi.direction === 'down' ? ArrowDown : ArrowUp
  const body = (
    <>
      <span className="flex h-5 min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {kpi.name}
        </span>
        <StaleMark tile={tile} now={now} />
      </span>
      <span className="mt-1 flex items-baseline gap-1.5">
        <span
          data-testid="kpi-value"
          className={[
            'truncate font-semibold tabular-nums tracking-tight',
            compact ? 'text-base' : 'text-xl',
            reading.value === null ? 'text-muted-foreground' : 'text-foreground',
          ].join(' ')}
        >
          {value}
        </span>
        <span
          className="inline-flex shrink-0 items-center text-muted-foreground"
          title={kpi.direction === 'down' ? 'Lower is better' : 'Higher is better'}
        >
          <DirIcon size={12} strokeWidth={2.25} aria-hidden />
          <span className="sr-only">
            {kpi.direction === 'down' ? 'Lower is better' : 'Higher is better'}
          </span>
        </span>
      </span>
      {!compact ? (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {[target, kpiWindow(kpi)].filter(Boolean).join(' · ')}
          {meets === true ? <span className="sr-only">. Meets its target.</span> : null}
        </span>
      ) : null}
      {!compact && percent !== null ? (
        <span className="mt-2 block">
          <ProgressBar
            percent={percent}
            color={meets ? 'var(--mint)' : 'rgb(var(--foreground-rgb) / 0.45)'}
            label={`${kpi.name}: ${percent}% of target`}
          />
        </span>
      ) : null}
      <span className="mt-auto flex min-w-0 items-center gap-1.5 pt-2" title={provenance}>
        <SourceBadge tile={tile} text={sourceBadge(tile, names)} />
        <span className="truncate text-micro text-muted-foreground">
          {reading.asOf !== null ? relativeTime(reading.asOf, now) : null}
        </span>
        <span className="sr-only">{provenance}</span>
      </span>
    </>
  )
  const shell = [
    'flex min-w-0 flex-col rounded-xl border border-border bg-surface text-left',
    compact ? 'p-2.5' : 'p-3',
  ].join(' ')
  if (!onOpen) {
    return (
      <div className={shell} data-testid="kpi-tile">
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="kpi-tile"
      onClick={() => onOpen(tile)}
      className={`${shell} cursor-pointer transition-colors duration-150 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2`}
    >
      {body}
    </button>
  )
}
