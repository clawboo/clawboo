// ─── Unified Scheduler REST ───────────────────────────
// The merged read/write surface over the ScheduleMultiplexer: clawboo Routines
// (team-task domain, managed) + the OpenClaw Gateway cron (runtime-own-life
// domain, external-write via the operator WS-RPC). Reads always 200 —
// per-source degradation is data; writes route by owner and surface the typed
// scheduling errors as precise statuses. The backend the Routines view consumes.

import type { Request, Response } from 'express'

import {
  getScheduledRun,
  getTask,
  listRoutineFires,
  ROUTINE_FIRES_MAX_LIMIT,
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
  parseScheduleId,
  type ScheduleCreateSpec,
  type ScheduleUpdatePatch,
} from '@clawboo/scheduler'

import { getDb } from '../lib/db'
import { enrichScheduleRecords } from '../lib/scheduleSource/enrich'
import { getScheduleMultiplexer } from '../lib/scheduleSource/registry'

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
