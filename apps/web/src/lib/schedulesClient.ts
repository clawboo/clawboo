// Defensive client for the unified Scheduler surface (/api/schedules) — the
// merged read over clawboo Routines (team-task) + the OpenClaw Gateway cron
// (runtime-own-life), with manageability-gated writes routed by owner. Reads
// never throw (an unreachable server → empty view); writes return a typed result
// carrying the server's error code so the UI can surface 403/409/422/503 cleanly.

import type {
  ScheduleCreateSpec,
  ScheduleRecord,
  ScheduleSourceReadStatus,
  ScheduleUpdatePatch,
} from '@clawboo/scheduler'

export type { ScheduleRecord, ScheduleSourceReadStatus } from '@clawboo/scheduler'

export interface SchedulesView {
  schedules: ScheduleRecord[]
  sources: ScheduleSourceReadStatus[]
}

export async function fetchSchedules(): Promise<SchedulesView> {
  try {
    const res = await fetch('/api/schedules')
    if (!res.ok) return { schedules: [], sources: [] }
    const body = (await res.json()) as Partial<SchedulesView>
    return { schedules: body.schedules ?? [], sources: body.sources ?? [] }
  } catch {
    return { schedules: [], sources: [] }
  }
}

export interface ScheduleActionResult {
  ok: boolean
  error?: string
  code?: string
}

async function parse(res: Response): Promise<ScheduleActionResult> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    return {
      ok: false,
      error: typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`,
      code: typeof data['code'] === 'string' ? data['code'] : undefined,
    }
  }
  return { ok: true }
}

function fail(err: unknown): ScheduleActionResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

async function send(url: string, method: string, body?: object): Promise<ScheduleActionResult> {
  try {
    const res = await fetch(url, {
      method,
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    })
    return parse(res)
  } catch (err) {
    return fail(err)
  }
}

export function createSchedule(spec: ScheduleCreateSpec): Promise<ScheduleActionResult> {
  return send('/api/schedules', 'POST', spec)
}

export function pauseSchedule(id: string): Promise<ScheduleActionResult> {
  return send(`/api/schedules/${encodeURIComponent(id)}`, 'PATCH', { action: 'pause' })
}

export function resumeSchedule(id: string): Promise<ScheduleActionResult> {
  return send(`/api/schedules/${encodeURIComponent(id)}`, 'PATCH', { action: 'resume' })
}

export function updateSchedule(
  id: string,
  patch: ScheduleUpdatePatch,
): Promise<ScheduleActionResult> {
  return send(`/api/schedules/${encodeURIComponent(id)}`, 'PATCH', { patch })
}

export function runScheduleNow(id: string): Promise<ScheduleActionResult> {
  return send(`/api/schedules/${encodeURIComponent(id)}/run`, 'POST')
}

export function deleteSchedule(id: string): Promise<ScheduleActionResult> {
  return send(`/api/schedules/${encodeURIComponent(id)}`, 'DELETE')
}
