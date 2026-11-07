// A task's plan document, for the drawer's Plan tab: the newest revision, or the one
// asked for, and the list of them all. A revision is never overwritten, so an older one
// stays readable after a newer one.

import { getTask, getTaskDocument, listTaskDocumentRevisions } from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDb } from '../lib/db'

// ─── GET /api/board/:taskId/plan ─────────────────────────────────────────────

export function boardPlanGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    if (!getTask(db, taskId)) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    const asked = req.query['revision']
    let revision: number | undefined
    if (asked !== undefined) {
      revision = Number(asked)
      if (!Number.isInteger(revision) || revision < 1) {
        res.status(400).json({ error: 'revision must be a whole number from 1' })
        return
      }
    }
    const plan = getTaskDocument(db, taskId, 'plan', revision)
    if (revision !== undefined && !plan) {
      res.status(404).json({ error: 'revision not found' })
      return
    }
    res.json({ plan, revisions: listTaskDocumentRevisions(db, taskId, 'plan') })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
