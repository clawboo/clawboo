// Next-occurrence math — the ONLY croner import in the monorepo. Swapping the
// tick library changes exactly this file: every consumer (the ledger, the
// ticker, the REST layer) deals in precomputed epoch-ms timestamps.

import { Cron } from 'croner'

import { InvalidCronSpecError } from './errors'
import { parseCronSpec } from './spec'

/**
 * The next fire time strictly after `fromMs`, or null when the spec will never
 * fire again (a spent `once@`, or an expression with no future occurrence).
 * Throws InvalidCronSpecError on a malformed spec.
 */
export function nextOccurrence(spec: string, fromMs: number): number | null {
  const parsed = parseCronSpec(spec)
  if (parsed.kind === 'once') return parsed.atMs > fromMs ? parsed.atMs : null
  let cron: Cron
  try {
    cron = new Cron(parsed.expr)
  } catch (err) {
    throw new InvalidCronSpecError(spec, err instanceof Error ? err.message : String(err))
  }
  const next = cron.nextRun(new Date(fromMs))
  return next ? next.getTime() : null
}

/**
 * Validate a spec without needing a meaningful `from` anchor — the
 * registration-boundary probe. Throws InvalidCronSpecError when malformed.
 */
export function probeCronSpec(spec: string): void {
  nextOccurrence(spec, 0)
}

/** The runs one window holds, as projected by `occurrencesInWindows`. */
export interface WindowOccurrences {
  /** Runs in the window, counted up to the cap. */
  count: number
  /** True when the window holds more runs than `count` (the cap was reached). */
  more: boolean
  /** The earliest run times in the window, ascending, at most `timesCap` of them. */
  times: number[]
}

export interface OccurrenceWindowOptions {
  /** Only runs strictly after this instant count, usually now. */
  after: number
  /** A run known to come first, counted before the spec is followed from it.
   *  A routine's stored next run is the instant the ticker will actually fire,
   *  which can differ from what the spec gives from now (a spec edited while a
   *  fire was in flight). Ignored unless it is after `after`. */
  first?: number
  /** The most runs counted in one window before `more` is set. Default 288,
   *  every five minutes for a whole day. */
  countCap?: number
  /** How many run times each window reports. Default 8. */
  timesCap?: number
}

/**
 * Project a spec's runs onto consecutive windows. `bounds` holds window edges in
 * ascending order, so window `i` is `[bounds[i], bounds[i + 1])`. The caller
 * picks the edges (a calendar sends the viewer's local midnights, which keeps
 * daylight-saving days correct), and this returns one entry per window.
 *
 * Work is bounded by the windows and the cap, not by the spec: a window that
 * reaches `countCap` is marked `more` and the rest of it is skipped.
 *
 * Throws InvalidCronSpecError on a malformed spec, and RangeError when `bounds`
 * is not at least two finite, strictly ascending numbers.
 */
export function occurrencesInWindows(
  spec: string,
  bounds: readonly number[],
  opts: OccurrenceWindowOptions,
): WindowOccurrences[] {
  if (bounds.length < 2) throw new RangeError('bounds needs at least two edges')
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i]!
    if (!Number.isFinite(b)) throw new RangeError('bounds must be finite numbers')
    if (i > 0 && b <= bounds[i - 1]!) throw new RangeError('bounds must be strictly ascending')
  }
  const countCap = Math.max(1, Math.floor(opts.countCap ?? 288))
  const timesCap = Math.max(0, Math.floor(opts.timesCap ?? 8))

  const parsed = parseCronSpec(spec)
  let next: (fromMs: number) => number | null
  if (parsed.kind === 'once') {
    next = (fromMs) => (parsed.atMs > fromMs ? parsed.atMs : null)
  } else {
    let cron: Cron
    try {
      cron = new Cron(parsed.expr)
    } catch (err) {
      throw new InvalidCronSpecError(spec, err instanceof Error ? err.message : String(err))
    }
    next = (fromMs) => cron.nextRun(new Date(fromMs))?.getTime() ?? null
  }

  const windows: WindowOccurrences[] = []
  for (let i = 1; i < bounds.length; i++) windows.push({ count: 0, more: false, times: [] })
  const end = bounds[bounds.length - 1]!

  // `next` is strictly-after, so starting one millisecond before the first edge
  // keeps a run that lands exactly on it.
  let cursor = Math.max(bounds[0]! - 1, opts.after)
  let w = 0
  let pending = opts.first != null && opts.first > opts.after ? opts.first : null
  if (pending != null && pending < bounds[0]!) {
    // The known run is before the windows; the spec takes over after it.
    cursor = Math.max(cursor, pending)
    pending = null
  }
  for (;;) {
    let t: number | null
    if (pending != null) {
      t = pending
      pending = null
    } else {
      t = next(cursor)
    }
    // `t <= cursor` cannot happen for a strictly-after `next`; it stops the loop
    // rather than spinning if a tick library ever returns a non-advancing time.
    if (t == null || t >= end || t <= cursor) break
    while (t >= bounds[w + 1]!) w++
    const slot = windows[w]!
    if (slot.count >= countCap) {
      slot.more = true
      // Skip the rest of this window: its count is already as far as it goes.
      cursor = bounds[w + 1]! - 1
      continue
    }
    slot.count++
    if (slot.times.length < timesCap) slot.times.push(t)
    cursor = t
  }
  return windows
}
