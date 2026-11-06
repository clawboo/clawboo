// A team's readable-id prefix and its labels. Reading is open to any caller of the
// API; changing them is a person's call, so a write must come from the dashboard's own
// page (`isDashboardRequest`: a speed bump, not a boundary) and goes on the audit
// feed with whoever a sign-in proxy vouched for.

import type { Request, Response } from 'express'

import {
  appendAudit,
  createLabel,
  deleteLabel,
  listLabels,
  readTeamTaskPrefix,
  renameLabel,
  setTeamTaskPrefix,
  type ClawbooDb,
  type LabelWriteResult,
} from '@clawboo/db'

import { personField } from '../lib/auth'
import { isDashboardRequest } from '../lib/dashboardRequest'
import { getDb } from '../lib/db'

const teamIdOf = (req: Request): string => (req.params['id'] as string | undefined) ?? ''

/** Refuse a write that did not come from the dashboard. True when refused. */
function refusedAsNotPerson(req: Request, res: Response): boolean {
  if (isDashboardRequest(req)) return false
  res.status(403).json({ error: 'person_only' })
  return true
}

function audit(
  db: ClawbooDb,
  req: Request,
  teamId: string,
  summary: Record<string, unknown>,
): void {
  appendAudit(db, { eventType: 'board', teamId, summary: { ...summary, ...personField(req) } })
}

// ─── GET /api/teams/:id/task-prefix ──────────────────────────────────────────

export function teamTaskPrefixGET(req: Request, res: Response): void {
  try {
    const prefix = readTeamTaskPrefix(getDb(), teamIdOf(req))
    if (!prefix) {
      res.status(404).json({ error: 'team not found' })
      return
    }
    res.json(prefix)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/teams/:id/task-prefix ──────────────────────────────────────────
// Body: { prefix }. Allowed until the team's first task exists.

export function teamTaskPrefixPUT(req: Request, res: Response): void {
  if (refusedAsNotPerson(req, res)) return
  const prefix = (req.body as { prefix?: unknown } | undefined)?.prefix
  if (typeof prefix !== 'string') {
    res.status(400).json({ error: 'invalid' })
    return
  }
  try {
    const db = getDb()
    const teamId = teamIdOf(req)
    const result = setTeamTaskPrefix(db, teamId, prefix)
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404 : result.reason === 'invalid' ? 400 : 409
      res.status(code).json({ error: result.reason })
      return
    }
    audit(db, req, teamId, { action: 'set_task_prefix', prefix: result.prefix })
    res.json({ prefix: result.prefix })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/teams/:id/labels ───────────────────────────────────────────────

export function teamLabelsGET(req: Request, res: Response): void {
  try {
    const labels = listLabels(getDb(), teamIdOf(req)).map((l) => ({ id: l.id, name: l.name }))
    res.json({ labels })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

function labelResponse(
  res: Response,
  result: LabelWriteResult,
  written: () => void,
  okCode = 200,
): void {
  if (!result.ok) {
    const code = result.reason === 'not_found' ? 404 : result.reason === 'invalid' ? 400 : 409
    res.status(code).json({ error: result.reason })
    return
  }
  written()
  res.status(okCode).json({ label: { id: result.label.id, name: result.label.name } })
}

// ─── POST /api/teams/:id/labels ──────────────────────────────────────────────
// Body: { name }.

export function teamLabelsPOST(req: Request, res: Response): void {
  if (refusedAsNotPerson(req, res)) return
  const name = (req.body as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'invalid' })
    return
  }
  try {
    const db = getDb()
    const teamId = teamIdOf(req)
    const result = createLabel(db, teamId, name)
    labelResponse(
      res,
      result,
      () => audit(db, req, teamId, { action: 'create_label', name: name.trim() }),
      201,
    )
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/teams/:id/labels/:labelId ────────────────────────────────────
// Body: { name }.

export function teamLabelPATCH(req: Request, res: Response): void {
  if (refusedAsNotPerson(req, res)) return
  const name = (req.body as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'invalid' })
    return
  }
  try {
    const db = getDb()
    const teamId = teamIdOf(req)
    const labelId = (req.params['labelId'] as string | undefined) ?? ''
    const result = renameLabel(db, teamId, labelId, name)
    labelResponse(res, result, () =>
      audit(db, req, teamId, { action: 'rename_label', labelId, name: name.trim() }),
    )
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/teams/:id/labels/:labelId ───────────────────────────────────

export function teamLabelDELETE(req: Request, res: Response): void {
  if (refusedAsNotPerson(req, res)) return
  try {
    const db = getDb()
    const teamId = teamIdOf(req)
    const labelId = (req.params['labelId'] as string | undefined) ?? ''
    if (!deleteLabel(db, teamId, labelId)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    audit(db, req, teamId, { action: 'delete_label', labelId })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
