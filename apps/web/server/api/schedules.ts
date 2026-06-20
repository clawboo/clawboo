// ─── Unified Scheduler REST ───────────────────────────
// The merged read/write surface over the ScheduleMultiplexer: clawboo Routines
// (team-task domain, managed) + the OpenClaw Gateway cron (runtime-own-life
// domain, external-write via the operator WS-RPC). Reads always 200 —
// per-source degradation is data; writes route by owner and surface the typed
// scheduling errors as precise statuses. The backend the Scheduler tab consumes.

import type { Request, Response } from 'express'

import {
  BoundRecurringScheduleError,
  DuplicateFiringOwnerError,
  IllegalScheduleTransitionError,
  InvalidCronSpecError,
  ScheduleSourceUnavailableError,
  TeamTaskDomainViolationError,
  UnknownScheduleError,
  UnsupportedScheduleWriteError,
  type ScheduleCreateSpec,
  type ScheduleUpdatePatch,
} from '@clawboo/scheduler'

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
    isZodError(err)
  ) {
    res.status(400).json({
      error: isZodError(err) ? 'invalid task template' : (err as Error).message,
      code: err instanceof BoundRecurringScheduleError ? err.code : 'invalid_body',
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
  res.json({ schedules: merged.records, sources: merged.sources })
}

// POST /api/schedules — body = ScheduleCreateSpec; routed by spec.source
export async function schedulesCreatePOST(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Partial<ScheduleCreateSpec>
  if (
    typeof body.agentId !== 'string' ||
    !body.agentId ||
    typeof body.cronSpec !== 'string' ||
    !body.cronSpec ||
    (body.source !== 'clawboo-routine' && body.source !== 'openclaw-gateway-cron') ||
    (body.domain !== 'team-task' && body.domain !== 'runtime-own-life')
  ) {
    res
      .status(400)
      .json({ error: 'source, domain, agentId, and cronSpec are required', code: 'invalid_body' })
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
    res
      .status(400)
      .json({
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
