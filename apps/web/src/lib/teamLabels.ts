// A team's readable-id prefix and its labels, over GET/PUT
// /api/teams/:id/task-prefix, /api/teams/:id/labels and PUT /api/board/:taskId/labels.
// Reads resolve null on any failure; writes resolve what the server said, so a form
// can show why it refused.

import { apiFetch } from '@clawboo/control-client'

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

export interface TeamTaskPrefix {
  prefix: string | null
  suggested: string
  locked: boolean
}

export interface TaskLabel {
  id: string
  name: string
}

export type PrefixRefusal = 'invalid' | 'taken' | 'locked' | 'not_found' | 'person_only' | 'failed'
export type LabelRefusal = 'invalid' | 'taken' | 'too_many' | 'not_found' | 'person_only' | 'failed'

const teamPath = (teamId: string, rest: string): string =>
  `/api/teams/${encodeURIComponent(teamId)}/${rest}`

export async function fetchTeamTaskPrefix(teamId: string): Promise<TeamTaskPrefix | null> {
  try {
    const res = await apiFetch(teamPath(teamId, 'task-prefix'))
    return res.ok ? ((await res.json()) as TeamTaskPrefix) : null
  } catch {
    return null
  }
}

/** Read why the server refused, or the fallback when it did not say. */
async function refusalOf<T extends string>(
  res: Response,
  known: readonly T[],
  fallback: T,
): Promise<T> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return known.includes(body.error as T) ? (body.error as T) : fallback
  } catch {
    return fallback
  }
}

const PREFIX_REFUSALS: readonly PrefixRefusal[] = [
  'invalid',
  'taken',
  'locked',
  'not_found',
  'person_only',
]

export async function saveTeamTaskPrefix(
  teamId: string,
  prefix: string,
): Promise<{ ok: true; prefix: string } | { ok: false; reason: PrefixRefusal }> {
  try {
    const res = await apiFetch(teamPath(teamId, 'task-prefix'), {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ prefix }),
    })
    if (!res.ok) return { ok: false, reason: await refusalOf(res, PREFIX_REFUSALS, 'failed') }
    const body = (await res.json()) as { prefix: string }
    return { ok: true, prefix: body.prefix }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

export async function fetchTeamLabels(teamId: string): Promise<TaskLabel[] | null> {
  try {
    const res = await apiFetch(teamPath(teamId, 'labels'))
    if (!res.ok) return null
    return ((await res.json()) as { labels: TaskLabel[] }).labels
  } catch {
    return null
  }
}

const LABEL_REFUSALS: readonly LabelRefusal[] = [
  'invalid',
  'taken',
  'too_many',
  'not_found',
  'person_only',
]

type LabelWrite = { ok: true; label: TaskLabel } | { ok: false; reason: LabelRefusal }

async function labelWrite(path: string, method: string, name: string): Promise<LabelWrite> {
  try {
    const res = await apiFetch(path, {
      method,
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    })
    if (!res.ok) return { ok: false, reason: await refusalOf(res, LABEL_REFUSALS, 'failed') }
    return { ok: true, label: ((await res.json()) as { label: TaskLabel }).label }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

export function createTeamLabel(teamId: string, name: string): Promise<LabelWrite> {
  return labelWrite(teamPath(teamId, 'labels'), 'POST', name)
}

export function renameTeamLabel(
  teamId: string,
  labelId: string,
  name: string,
): Promise<LabelWrite> {
  return labelWrite(teamPath(teamId, `labels/${encodeURIComponent(labelId)}`), 'PATCH', name)
}

export async function deleteTeamLabel(teamId: string, labelId: string): Promise<boolean> {
  try {
    const res = await apiFetch(teamPath(teamId, `labels/${encodeURIComponent(labelId)}`), {
      method: 'DELETE',
    })
    return res.ok
  } catch {
    return false
  }
}

/** Replace a task's labels. Resolves the set it now has, or null when refused. */
export async function setTaskLabels(
  taskId: string,
  labelIds: readonly string[],
): Promise<TaskLabel[] | null> {
  try {
    const res = await apiFetch(`/api/board/${encodeURIComponent(taskId)}/labels`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ labelIds }),
    })
    if (!res.ok) return null
    return ((await res.json()) as { labels: TaskLabel[] }).labels
  } catch {
    return null
  }
}

/** A task's labels as the board's reads carry them. */
export function labelsOfTask(task: object): TaskLabel[] {
  const labels = (task as { labels?: unknown }).labels
  return Array.isArray(labels) ? (labels as TaskLabel[]) : []
}
