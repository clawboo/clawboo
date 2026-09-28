// Defensive client for the unified schedule surface (/api/schedules) behind the
// Routines view: the merged read over clawboo Routines (team-task) + the OpenClaw
// Gateway cron (runtime-own-life), with manageability-gated writes routed by
// owner. Reads never throw (an unreachable server → empty view); writes return a
// typed result carrying the server's error code so the UI can surface
// 400/403/409/422/503 cleanly.

import type {
  ScheduleCreateSpec,
  ScheduleRecord,
  ScheduleSourceReadStatus,
  ScheduleUpdatePatch,
} from '@clawboo/scheduler'
import { apiFetch } from '@clawboo/control-client'

export type { ScheduleRecord, ScheduleSourceReadStatus } from '@clawboo/scheduler'

export interface SchedulesView {
  schedules: ScheduleRecord[]
  sources: ScheduleSourceReadStatus[]
  /** False when the read itself failed: the lists are empty because nothing
   *  arrived, not because nothing is scheduled, so a caller keeps what it has. */
  ok: boolean
}

export async function fetchSchedules(): Promise<SchedulesView> {
  try {
    const res = await apiFetch('/api/schedules')
    if (!res.ok) return { schedules: [], sources: [], ok: false }
    const body = (await res.json()) as Partial<SchedulesView>
    return { schedules: body.schedules ?? [], sources: body.sources ?? [], ok: true }
  } catch {
    return { schedules: [], sources: [], ok: false }
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
    const res = await apiFetch(url, {
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

/** One fire of a routine, newest first from `fetchRoutineRuns`. */
export interface RoutineRun {
  firedAt: number
  finishedAt: number | null
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  error: string | null
  taskId: string | null
  dispatchPath: string | null
  targetAgentId: string | null
  /** The board task an agent routine's fire created, as it stands now. */
  task: { id: string; title: string; status: string } | null
}

/** A routine's recent fires. Null when they could not be read (as opposed to none). */
export async function fetchRoutineRuns(id: string, limit = 10): Promise<RoutineRun[] | null> {
  try {
    const res = await apiFetch(`/api/schedules/${encodeURIComponent(id)}/runs?limit=${limit}`)
    if (!res.ok) return null
    const body = (await res.json()) as { runs?: RoutineRun[] }
    return body.runs ?? []
  } catch {
    return null
  }
}
