// ─── Unified Scheduler REST ───────────────────────────
// The merged read/write surface over the ScheduleMultiplexer: clawboo Routines
// (team-task domain, managed) + the OpenClaw Gateway cron (runtime-own-life
// domain, external-write via the operator WS-RPC). Reads always 200 —
// per-source degradation is data; writes route by owner and surface the typed
// scheduling errors as precise statuses. The backend the Routines view consumes.

import type { Request, Response } from 'express'

import {
  agents,
  getScheduledRun,
  getTask,
  listRoutineFires,
  ROUTINE_FIRES_MAX_LIMIT,
  teams,
  type ClawbooDb,
  type RoutineFire,
} from '@clawboo/db'
import {
  BoundRecurringScheduleError,
  DuplicateFiringOwnerError,
  IllegalScheduleTransitionError,
  InvalidCronSpecError,
  InvalidRoutineTargetError,
  ScheduleSourceUnavailableError,
  TeamTaskDomainViolationError,
  UnknownScheduleError,
  UnsupportedScheduleWriteError,
  occurrencesInWindows,
  parseScheduleId,
  type ScheduleCreateSpec,
  type ScheduleRecord,
  type ScheduleStatus,
  type ScheduleUpdatePatch,
  type WindowOccurrences,
} from '@clawboo/scheduler'

import { eq } from 'drizzle-orm'

import { getDb } from '../lib/db'
import { ClawbooRoutineScheduleSource } from '../lib/scheduleSource/clawbooRoutineScheduleSource'
import { enrichScheduleRecords } from '../lib/scheduleSource/enrich'
import { getScheduleMultiplexer } from '../lib/scheduleSource/registry'
import { resolveServerOrchestrated } from '../lib/teamChat/resolveServerOrchestrated'
import { resolveTeamLeadId } from '../lib/teamChat/teamLead'

// Structural ZodError check — apps/web carries no direct zod dep; the schema
// validation lives inside @clawboo/scheduler.
function isZodError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ZodError'
}

function mapScheduleError(err: unknown, res: Response): void {
  if (
    err instanceof InvalidCronSpecError ||
    err instanceof BoundRecurringScheduleError ||
    err instanceof InvalidRoutineTargetError ||
    isZodError(err)
  ) {
    res.status(400).json({
      error: isZodError(err) ? 'invalid task template' : (err as Error).message,
      code:
        err instanceof BoundRecurringScheduleError || err instanceof InvalidRoutineTargetError
          ? err.code
          : 'invalid_body',
    })
    return
  }
  if (err instanceof UnknownScheduleError) {
    res.status(404).json({ error: err.message, code: err.code })
    return
  }
  if (err instanceof DuplicateFiringOwnerError || err instanceof IllegalScheduleTransitionError) {
    // The one-firing-owner refusal + illegal transitions: conflicts — never retried.
    res.status(409).json({ error: err.message, code: err.code })
    return
  }
  if (err instanceof TeamTaskDomainViolationError) {
    res.status(422).json({ error: err.message, code: err.code })
    return
  }
  if (err instanceof UnsupportedScheduleWriteError) {
    res.status(403).json({ error: err.message, code: err.code })
    return
  }
  if (err instanceof ScheduleSourceUnavailableError) {
    res.status(503).json({ error: 'gateway_disconnected', code: err.code })
    return
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

function scheduleId(req: Request): string {
  return decodeURIComponent(String(req.params['id'] ?? ''))
}

// GET /api/schedules — the merged view (degradation is data, always 200)
export async function schedulesListGET(_req: Request, res: Response): Promise<void> {
  const merged = await getScheduleMultiplexer().read()
  let schedules = merged.records
  try {
    schedules = enrichScheduleRecords(getDb(), merged.records)
  } catch {
    // Names are a convenience: the rows are still right without them.
  }
  res.json({ schedules, sources: merged.sources })
}

// GET /api/schedules/occurrences?bounds=<ms>,<ms>,...&teamId=<id>
// The upcoming runs of clawboo's own routines, projected onto the windows the
// caller names. The Board's calendar sends the viewer's local midnights, so
// window `i` is one day, `[bounds[i], bounds[i + 1])`. Only runs after now are
// projected, and only for routines that will actually fire: a paused routine,
// one parked after a failure, and a spent one-shot have none. The projection
// runs here rather than in the browser because the ticker evaluates cron in
// this process's time zone, so these are the instants it will fire at.
// OpenClaw's own cron jobs are the Gateway's business and are not included.

const OCCURRENCE_MAX_EDGES = 64
const OCCURRENCE_MAX_SPAN_MS = 62 * 24 * 60 * 60 * 1000
const ARMED_STATUSES: ReadonlySet<ScheduleStatus> = new Set([
  'idle',
  'queued',
  'claimed',
  'running',
])
const routineSource = new ClawbooRoutineScheduleSource({ getDb })

/** Window edges from the query, or null when they are not a usable range. */
function parseOccurrenceBounds(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || !raw) return null
  const parts = raw.split(',')
  if (parts.length < 2 || parts.length > OCCURRENCE_MAX_EDGES) return null
  const bounds = parts.map((p) => Number(p.trim()))
  for (let i = 0; i < bounds.length; i++) {
    if (!Number.isSafeInteger(bounds[i])) return null
    if (i > 0 && bounds[i]! <= bounds[i - 1]!) return null
  }
  if (bounds[bounds.length - 1]! - bounds[0]! > OCCURRENCE_MAX_SPAN_MS) return null
  return bounds
}

/** Whether the ticker will fire this routine again. An idle routine with no
 *  next run is a spent one-shot. */
function willFire(rec: ScheduleRecord): boolean {
  if (!ARMED_STATUSES.has(rec.status)) return false
  return rec.status !== 'idle' || rec.nextRunAt != null
}

/**
 * Whether a fire could reach its target. The dispatcher refuses a team routine
 * whose team is gone, archived, closed to routine messages or without members,
 * and an agent routine whose agent is gone, archived or a person, and that first
 * refusal parks the routine; so a routine like that has no runs to show.
 */
function canReachTarget(db: ClawbooDb, rec: ScheduleRecord): boolean {
  if (rec.target === 'team') {
    if (!rec.teamId) return false
    const team = db
      .select({ isArchived: teams.isArchived })
      .from(teams)
      .where(eq(teams.id, rec.teamId))
      .get() as { isArchived: number } | undefined
    if (!team || team.isArchived) return false
    if (!resolveServerOrchestrated(db, rec.teamId)) return false
    return resolveTeamLeadId(db, rec.teamId) != null
  }
  const agent = db
    .select({ archivedAt: agents.archivedAt, participantKind: agents.participantKind })
    .from(agents)
    .where(eq(agents.id, rec.agentId))
    .get() as { archivedAt: number | null; participantKind: string | null } | undefined
  return !!agent && !agent.archivedAt && agent.participantKind !== 'human'
}

// Every board tab polls this, and a frequent routine is the expensive case: a
// run every five minutes is a few thousand cron steps across a month. Counting a
// window stops at OCCURRENCE_COUNT_CAP (the strip then reads "96+ runs"), and a
// projection is reused until its first run passes or a minute goes by. A write to
// a routine changes its spec, status or next run, which are part of the key.
const OCCURRENCE_COUNT_CAP = 96
const OCCURRENCE_CACHE_MS = 60_000
const OCCURRENCE_CACHE_MAX = 500
const occurrenceCache = new Map<string, { windows: WindowOccurrences[]; validUntil: number }>()

function projectRoutine(
  rec: ScheduleRecord,
  bounds: readonly number[],
  boundsKey: string,
  now: number,
): WindowOccurrences[] {
  // The stored next run is the instant the ticker fires an idle routine at.
  const first = rec.status === 'idle' && rec.nextRunAt != null ? rec.nextRunAt : undefined
  const key = `${rec.id}|${rec.cronSpec}|${rec.status}|${first ?? ''}|${boundsKey}`
  const hit = occurrenceCache.get(key)
  if (hit && hit.validUntil > now) return hit.windows
  const windows = occurrencesInWindows(rec.cronSpec, bounds, {
    after: now,
    first,
    countCap: OCCURRENCE_COUNT_CAP,
  })
  let soonest = Infinity
  for (const w of windows) if (w.times[0] != null && w.times[0] < soonest) soonest = w.times[0]
  if (occurrenceCache.size >= OCCURRENCE_CACHE_MAX) occurrenceCache.clear()
  occurrenceCache.set(key, { windows, validUntil: Math.min(now + OCCURRENCE_CACHE_MS, soonest) })
  return windows
}

/** The server's time zone: cron is evaluated here, so a client whose zone
 *  differs can say so beside a routine's schedule. */
function serverTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null
  } catch {
    return null
  }
}

export async function schedulesOccurrencesGET(req: Request, res: Response): Promise<void> {
  const bounds = parseOccurrenceBounds(req.query['bounds'])
  if (!bounds) {
    res.status(400).json({
      error: `bounds must be 2 to ${OCCURRENCE_MAX_EDGES} ascending epoch-ms integers spanning at most 62 days`,
      code: 'invalid_bounds',
    })
    return
  }
  const teamId =
    typeof req.query['teamId'] === 'string' && req.query['teamId'] ? req.query['teamId'] : null
  try {
    const db = getDb()
    const now = Date.now()
    const { records } = await routineSource.read()
    let armed = records.filter(
      (r) => willFire(r) && (teamId === null || r.teamId === teamId) && canReachTarget(db, r),
    )
    try {
      armed = enrichScheduleRecords(db, armed)
    } catch {
      // Names are a convenience: the runs are still right without them.
    }
    const boundsKey = bounds.join(',')
    const routines: Array<{ schedule: ScheduleRecord; windows: WindowOccurrences[] }> = []
    for (const schedule of armed) {
      let windows: WindowOccurrences[]
      try {
        windows = projectRoutine(schedule, bounds, boundsKey, now)
      } catch {
        // A spec the ticker cannot read never fires, so it has nothing to show.
        continue
      }
      if (windows.some((w) => w.count > 0)) routines.push({ schedule, windows })
    }
    res.json({ now, timeZone: serverTimeZone(), routines })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

/** Test-only: forget cached projections. */
export function resetOccurrenceCache(): void {
  occurrenceCache.clear()
}

// POST /api/schedules — body = ScheduleCreateSpec; routed by spec.source
// A team routine (`target: 'team'`) names a team instead of an agent; every other
// create names the agent it runs on.
export async function schedulesCreatePOST(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Partial<ScheduleCreateSpec>
  const teamRoutine = body.source === 'clawboo-routine' && body.target === 'team'
  if (
    typeof body.cronSpec !== 'string' ||
    !body.cronSpec ||
    (body.source !== 'clawboo-routine' && body.source !== 'openclaw-gateway-cron') ||
    (body.domain !== 'team-task' && body.domain !== 'runtime-own-life') ||
    (body.target !== undefined && body.target !== 'team' && body.target !== 'agent') ||
    (teamRoutine
      ? typeof body.teamId !== 'string' || !body.teamId
      : typeof body.agentId !== 'string' || !body.agentId)
  ) {
    res.status(400).json({
      error:
        'source, domain, cronSpec, and an agentId (or a teamId for a team routine) are required',
      code: 'invalid_body',
    })
    return
  }
  try {
    const schedule = await getScheduleMultiplexer().write({
      kind: 'create',
      spec: body as ScheduleCreateSpec,
    })
    res.status(201).json({ schedule })
  } catch (err) {
    mapScheduleError(err, res)
  }
}

// PATCH /api/schedules/:id — { action: 'pause' | 'resume' } | { patch: ScheduleUpdatePatch }
export async function schedulesUpdatePATCH(req: Request, res: Response): Promise<void> {
  const id = scheduleId(req)
  const body = (req.body ?? {}) as { action?: string; patch?: ScheduleUpdatePatch }
  try {
    if (body.action === 'pause' || body.action === 'resume') {
      const schedule = await getScheduleMultiplexer().write({ kind: body.action, id })
      res.json({ schedule })
      return
    }
    if (body.patch && typeof body.patch === 'object') {
      const schedule = await getScheduleMultiplexer().write({
        kind: 'update',
        id,
        patch: body.patch,
      })
      res.json({ schedule })
      return
    }
    res.status(400).json({
      error: "body needs { action: 'pause' | 'resume' } or { patch }",
      code: 'invalid_body',
    })
  } catch (err) {
    mapScheduleError(err, res)
  }
}

// DELETE /api/schedules/:id
export async function schedulesDELETE(req: Request, res: Response): Promise<void> {
  try {
    await getScheduleMultiplexer().write({ kind: 'remove', id: scheduleId(req) })
    res.json({ ok: true })
  } catch (err) {
    mapScheduleError(err, res)
  }
}

// POST /api/schedules/:id/run — force-fire now (enqueue-style ack)
export async function schedulesRunPOST(req: Request, res: Response): Promise<void> {
  try {
    await getScheduleMultiplexer().write({ kind: 'run', id: scheduleId(req) })
    res.status(202).json({ ok: true })
  } catch (err) {
    mapScheduleError(err, res)
  }
}

// GET /api/schedules/:id/runs
// A routine's recent fires, newest first. An agent routine's fire carries the
// board task it created, resolved to its current title and status. Gateway jobs
// keep their run history in OpenClaw, so they have none here.
export function schedulesRunsGET(req: Request, res: Response): void {
  const id = scheduleId(req)
  const parsed = parseScheduleId(id)
  if (!parsed) {
    res.status(404).json({ error: `Unknown schedule "${id}"`, code: 'unknown_schedule' })
    return
  }
  if (parsed.source !== 'clawboo-routine') {
    res.json({ runs: [] })
    return
  }
  try {
    const db = getDb()
    const row = getScheduledRun(db, parsed.sourceScheduleId)
    if (!row) {
      res.status(404).json({ error: `Unknown schedule "${id}"`, code: 'unknown_schedule' })
      return
    }
    const requested = Number(req.query['limit'])
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), ROUTINE_FIRES_MAX_LIMIT)
      : 10
    const fires: RoutineFire[] = listRoutineFires(db, row.id, { limit })
    // The newest fire can only still be running while the routine is. Once the
    // row has moved on without recording an outcome for it, a restart cut it off.
    const inFlight = row.status === 'queued' || row.status === 'claimed' || row.status === 'running'
    const latest = fires[0]
    if (latest && latest.status === 'running' && !inFlight) latest.status = 'interrupted'
    const runs = fires.map((fire) => {
      const task = fire.taskId ? getTask(db, fire.taskId) : null
      return {
        ...fire,
        task: task ? { id: task.id, title: task.title, status: task.status } : null,
      }
    })
    res.json({ runs })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
