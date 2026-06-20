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
