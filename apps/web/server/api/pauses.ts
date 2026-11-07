// A person's durable pause of an agent, a team or a task tree.
//
//   GET    /api/pauses              every pause, with what it is called
//   POST   /api/pauses              { kind: 'agent' | 'team' | 'task', id, reason? }
//   DELETE /api/pauses/:kind/:id    resume it
//
// `task` names any task in a tree: the tree is paused or resumed from its root.
// Writes are a person's, so they take the one person check (`refuseUnlessPerson`: a
// speed bump locally, not a boundary), and the event says who did it. See lib/pauseRuns
// for what a pause stops and what it does not, and @clawboo/db's board/pauses for what
// it covers.

import { taskTreeRootId, type ClawbooDb, type PauseKind } from '@clawboo/db'
import type { Request, Response } from 'express'

import { actorField, refuseUnlessPerson } from '../lib/auth'
import { ownWriterOf } from '../lib/boardReader'
import { getDb } from '../lib/db'
import { pauseRuns, resumeRuns } from '../lib/pauseRuns'
import { pauseTargetName, pauseViews } from '../lib/pauseViews'

/** The longest reason a person may give. */
export const PAUSE_REASON_MAX = 200

/** A request's `kind` and `id` as the row names them: a task's tree by its root. */
function scopeOf(
  db: ClawbooDb,
  kind: unknown,
  id: unknown,
): { kind: PauseKind; id: string } | null {
  if (typeof id !== 'string' || id === '') return null
  if (kind === 'agent' || kind === 'team') return { kind, id }
  if (kind === 'task' || kind === 'task_tree')
    return { kind: 'task_tree', id: taskTreeRootId(db, id) }
  return null
}

export function pausesGET(_req: Request, res: Response): void {
  try {
    res.json({ pauses: pauseViews(getDb()) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

export function pausesPOST(req: Request, res: Response): void {
  try {
    if (refuseUnlessPerson(req, res)) return
    const body = (req.body ?? {}) as { kind?: unknown; id?: unknown; reason?: unknown }
    const db = getDb()
    const scope = scopeOf(db, body.kind, body.id)
    if (!scope) {
      res.status(400).json({ ok: false, error: 'kind must be agent, team or task, with its id.' })
      return
    }
    let reason: string | null = null
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string' || body.reason.trim().length > PAUSE_REASON_MAX) {
        res.status(400).json({
          ok: false,
          error: `reason must be text of at most ${PAUSE_REASON_MAX} characters.`,
        })
        return
      }
      reason = body.reason.trim() || null
    }
    const name = pauseTargetName(db, scope.kind, scope.id)
    if (name === null) {
      res.status(404).json({ ok: false, error: 'not_found' })
      return
    }
    const { pause, created } = pauseRuns(db, {
      ...scope,
      reason,
      ...actorField(req),
      reader: ownWriterOf(req),
    })
    res.status(created ? 201 : 200).json({ ok: true, created, pause: { ...pause, name } })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

export function pausesDELETE(req: Request, res: Response): void {
  try {
    if (refuseUnlessPerson(req, res)) return
    const db = getDb()
    const scope = scopeOf(db, req.params['kind'], req.params['id'])
    if (!scope) {
      res.status(400).json({ ok: false, error: 'kind must be agent, team or task, with its id.' })
      return
    }
    if (!resumeRuns(db, scope.kind, scope.id, actorField(req))) {
      res.status(404).json({ ok: false, error: 'not_paused' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}
