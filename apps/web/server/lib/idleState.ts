// The answer a host that sleeps and wakes this engine reads before it stops it:
// is a person here, is work going, and when is the next scheduled work due.
// Served by GET /api/system/idle. Read-only: it writes nothing, starts nothing,
// and reading it is not presence.
//
// A person is here when the presence record says so (see presence.ts), or while
// a person holds an agent's screen (Take over): someone driving an agent's
// screen through a control link's page sends no presence beat, and stopping the
// engine would cut them off mid-sign-in.
//
// The next due time is read from every schedule source, each in one of three
// states, so a source that is not set up never reads as one that could not be
// read:
//   ok       read now; `at` is its earliest next run, or null with none
//   off      not in use: nothing set up (no Gateway configured, say), or its jobs
//            run somewhere this engine's stopping does not stop (a Gateway on
//            another machine)
//   unknown  in use but not readable now (a Gateway still connecting after a
//            wake, or one that is set up and stopped); `at` is the earliest next
//            run it reported before, if one is still ahead
// The engine's own routines are read from the ledger with the ticker's rules
// (see routinesDue), not from the merged schedules list, which also lists paused
// routines and ones on archived teams.

import type {
  EngineIdleState,
  IdleDueSource,
  IdleNextDue,
  IdlePeople,
  IdleWork,
} from '@clawboo/control-client'
import type { ClawbooDb } from '@clawboo/db'
import {
  SCHEDULE_SOURCE_NOT_CONFIGURED,
  decodeCronSpec,
  type ScheduleReadResult,
  type ScheduleSource,
} from '@clawboo/scheduler'

import { engineHoldState } from '../api/systemHold'
import { getRegistry } from './agentSource'
import { getDb } from './db'
import { screensInPersonControl } from './desktop/control'
import { presence } from './presence'
import { routinesDue } from './routines/ticker'
import { readSchedulerTimeZone } from './routines/timeZone'
import { getScheduleMultiplexer } from './scheduleSource/registry'
import { teamChecksInFlight } from './teamChat/teamOrchestrator'

/** How long one schedule source may take to answer before it reads as `unknown`. */
export const IDLE_SOURCE_READ_TIMEOUT_MS = 3_000

const ROUTINES_SOURCE_ID = 'clawboo-routine'
const GATEWAY_CRON_SOURCE_ID = 'openclaw-gateway-cron'

export interface IdleStateDeps {
  db?: ClawbooDb
  now?: () => number
  /** The schedule sources besides the engine's own routines. */
  sources?: () => readonly ScheduleSource[]
  /** True when the configured OpenClaw Gateway runs on another machine. */
  gatewayIsRemote?: () => boolean
}

/** The presence record, with a person who holds an agent's screen counted as here. */
function peopleState(): IdlePeople {
  const people = presence().state()
  return screensInPersonControl() > 0 ? { ...people, present: true } : people
}

/** The hold route's answer, plus the work checks and routine fires it folds in. */
function workState(routinesInFlight: number): IdleWork {
  const hold = engineHoldState()
  return {
    backgroundWork: hold.backgroundWork,
    runs: hold.runs,
    checks: teamChecksInFlight(),
    routinesInFlight,
    held: hold.held,
  }
}

function withTimeout(source: ScheduleSource): Promise<ScheduleReadResult | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), IDLE_SOURCE_READ_TIMEOUT_MS)
    timer.unref?.()
    source.read().then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (err: unknown) => {
        clearTimeout(timer)
        resolve({
          records: [],
          status: {
            sourceId: source.id,
            ok: false,
            degraded: true,
            reason: err instanceof Error ? err.message : String(err),
            at: Date.now(),
          },
        })
      },
    )
  })
}

/** The zone a schedule's next run was worked out in, when its spec names one. A
 *  fixed interval or a fixed time has none, and neither has a cron expression that
 *  leaves the zone to the system that runs it. */
function zoneOf(cronSpec: string): string | null {
  try {
    const shape = decodeCronSpec(cronSpec)
    return shape.kind === 'cron' && shape.tz ? shape.tz : null
  } catch {
    return null
  }
}

/** The earliest next run among a source's schedules that are switched on. */
function earliest(result: ScheduleReadResult): {
  at: number | null
  count: number
  timeZone: string | null
} {
  let at: number | null = null
  let count = 0
  let timeZone: string | null = null
  for (const record of result.records) {
    if (record.status === 'paused') continue
    const next = record.nextRunAt
    if (typeof next !== 'number' || !Number.isFinite(next)) continue
    count += 1
    if (at === null || next < at) {
      at = next
      timeZone = zoneOf(record.cronSpec)
    }
  }
  return { at, count, timeZone }
}

async function readSource(
  source: ScheduleSource,
  nowMs: number,
  deps: IdleStateDeps,
): Promise<IdleDueSource> {
  if (source.id === GATEWAY_CRON_SOURCE_ID && deps.gatewayIsRemote?.()) {
    // Its cron fires on the Gateway's own machine whether or not this engine sleeps.
    return { id: source.id, state: 'off', at: null, count: 0, timeZone: null, reason: 'remote' }
  }
  const result = await withTimeout(source)
  if (result === 'timeout') {
    return {
      id: source.id,
      state: 'unknown',
      at: null,
      count: 0,
      timeZone: null,
      reason: 'timeout',
    }
  }
  if (result.status.ok) return { id: source.id, state: 'ok', ...earliest(result) }
  if (result.status.reason === SCHEDULE_SOURCE_NOT_CONFIGURED) {
    return {
      id: source.id,
      state: 'off',
      at: null,
      count: 0,
      timeZone: null,
      reason: result.status.reason,
    }
  }
  // What it sent last, if it sent anything: only times still ahead, since a cache
  // is not refreshed while the source is down and a passed time would read as due
  // now for as long as it stays down.
  const ahead = { ...result, records: result.records.filter((r) => (r.nextRunAt ?? 0) > nowMs) }
  return {
    id: source.id,
    state: 'unknown',
    ...earliest(ahead),
    reason: result.status.reason ?? 'unreadable',
  }
}

async function nextDueState(
  routines: IdleDueSource,
  timeZone: string,
  nowMs: number,
  deps: IdleStateDeps,
): Promise<IdleNextDue> {
  const others = (deps.sources ?? defaultSources)().filter((s) => s.id !== ROUTINES_SOURCE_ID)
  const entries = [
    routines,
    ...(await Promise.all(others.map((source) => readSource(source, nowMs, deps)))),
  ]
  let at: number | null = null
  for (const entry of entries) {
    if (entry.at !== null && (at === null || entry.at < at)) at = entry.at
  }
  return {
    at,
    complete: entries.every((entry) => entry.state !== 'unknown'),
    timeZone,
    sources: entries,
  }
}

function defaultSources(): readonly ScheduleSource[] {
  return getScheduleMultiplexer().list()
}

function defaultGatewayIsRemote(): boolean {
  const source = getRegistry().source
  return source.isConfigured() && !source.isOnThisMachine()
}

export async function buildIdleState(deps: IdleStateDeps = {}): Promise<EngineIdleState> {
  const at = (deps.now ?? Date.now)()
  // The engine's own routines, from the ledger. A database that cannot be read
  // leaves them unknown rather than failing the whole answer.
  let routines: IdleDueSource
  let inFlight = 0
  let timeZone = 'UTC'
  try {
    const db = deps.db ?? getDb()
    timeZone = readSchedulerTimeZone(db).timeZone
    const due = routinesDue(db, at)
    inFlight = due.inFlight
    routines = { id: ROUTINES_SOURCE_ID, state: 'ok', at: due.at, count: due.count, timeZone }
  } catch (err) {
    routines = {
      id: ROUTINES_SOURCE_ID,
      state: 'unknown',
      at: null,
      count: 0,
      timeZone: null,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  const nextDue = await nextDueState(routines, timeZone, at, {
    ...deps,
    gatewayIsRemote: deps.gatewayIsRemote ?? defaultGatewayIsRemote,
  })
  return { at, people: peopleState(), work: workState(inFlight), nextDue }
}
