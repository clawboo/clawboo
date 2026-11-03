// The time zone routines are worked out in.
//
// A cron expression is wall-clock time, so reading it needs a zone. With nothing
// stored that is the host's zone (the server process's own, which honours TZ),
// and an install that never sets one runs exactly the arithmetic it always has.
// A server in a container runs in UTC unless TZ is set, so the zone is also a
// setting of its own: an IANA name in the settings table, independent of the
// process, changed from where a routine's time is chosen.

import {
  getSetting,
  rearmIdleScheduledRuns,
  setSetting,
  settings,
  type ClawbooDb,
} from '@clawboo/db'
import { isOnceSpec, nextOccurrence } from '@clawboo/scheduler'
import { eq } from 'drizzle-orm'

export const SCHEDULER_TIME_ZONE_KEY = 'scheduler-time-zone'

/** Longer than any IANA name; a bound on what reaches Intl. */
const MAX_ZONE_NAME = 64

/** The host's zone: the process's own. */
export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * A time zone name as stored, or null when it names none. Kept as given apart
 * from letter case (`utc` is stored as `UTC`): Node reports some zones by an
 * older alias (`Asia/Kolkata` as `Asia/Calcutta`), and the name a person picked
 * is the one to show them.
 */
export function normalizeTimeZone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!name || name.length > MAX_ZONE_NAME) return null
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions()
      .timeZone
    return canonical.toLowerCase() === name.toLowerCase() ? canonical : name
  } catch {
    return null
  }
}

export interface SchedulerTimeZone {
  /** The zone routines are worked out in. */
  timeZone: string
  /** The host's zone, which applies while none is stored. */
  hostTimeZone: string
  /** True when a zone is stored, false when the host's applies. */
  configured: boolean
}

function storedTimeZone(db: ClawbooDb): string | null {
  return normalizeTimeZone(getSetting(db, SCHEDULER_TIME_ZONE_KEY))
}

export function readSchedulerTimeZone(db: ClawbooDb): SchedulerTimeZone {
  const host = hostTimeZone()
  const stored = storedTimeZone(db)
  return { timeZone: stored ?? host, hostTimeZone: host, configured: stored != null }
}

/**
 * The zone to hand the cron math: the stored one, or undefined to work in the
 * process's own zone. Undefined rather than the host's name, so an install with
 * nothing stored computes exactly what it always has.
 */
export function routineTimeZone(db: ClawbooDb): string | undefined {
  return storedTimeZone(db) ?? undefined
}

/**
 * Store the scheduler zone (null follows the host again), then move every armed
 * routine's next run onto the new zone's wall clock. Without that, each
 * routine's next fire would still be the instant worked out in the old zone.
 * Returns the zone now in force. Throws RangeError on a name that is not a zone.
 */
export function writeSchedulerTimeZone(
  db: ClawbooDb,
  raw: string | null,
  now = Date.now(),
): SchedulerTimeZone {
  const before = readSchedulerTimeZone(db).timeZone
  if (raw === null) {
    db.delete(settings).where(eq(settings.key, SCHEDULER_TIME_ZONE_KEY)).run()
  } else {
    const zone = normalizeTimeZone(raw)
    if (!zone) throw new RangeError(`not a time zone: ${raw}`)
    setSetting(db, SCHEDULER_TIME_ZONE_KEY, zone)
  }
  const after = readSchedulerTimeZone(db)
  if (after.timeZone !== before) {
    const zone = routineTimeZone(db)
    rearmIdleScheduledRuns(
      db,
      (spec) => (isOnceSpec(spec) ? null : nextOccurrence(spec, now, zone)),
      now,
    )
  }
  return after
}
