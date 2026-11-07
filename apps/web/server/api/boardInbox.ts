// ─── A person's inbox ────────────────────────────────────────────────────────
// What changed on the board since this person last looked, from any browser. See
// @clawboo/db's board/readState.ts for what "unread" means, and lib/boardReader.ts
// for who the reader is.
//
// Marking is a person's write, so it needs the dashboard's own page or a person a
// sign-in proxy vouched for. These routes stay under /api/ and off /api/mcp/, where
// a runtime's token reaches.

import type { Request, Response } from 'express'

import {
  boardActivityHead,
  getTask,
  listPendingApprovals,
  markAllReadBody,
  markAllTasksRead,
  markTaskRead,
  markTaskReadBody,
  taskIdsNeedingPerson,
  unreadTasks,
} from '@clawboo/db'

import { ownWriterOf, readerOf } from '../lib/boardReader'
import { getDb } from '../lib/db'

/** The badge stops counting at 99+, so a list past this says nothing more. */
const INBOX_LIST_CAP = 100

// ─── GET /api/board/inbox ────────────────────────────────────────────────────
// The small read behind the badge, taken once per burst of events rather than on a
// timer. `through` is the newest change this read knew of, read first so that "mark
// all read" can never cover a change the list did not show.
export function boardInboxGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const reader = readerOf(req)
    const through = boardActivityHead(db)
    res.json({
      unread: unreadTasks(db, reader, { limit: INBOX_LIST_CAP }),
      needsYou: taskIdsNeedingPerson(db).slice(0, INBOX_LIST_CAP),
      approvals: listPendingApprovals(db).map((a) => a.id),
      through,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/:taskId/read ────────────────────────────────────────────
// The person opened the task. `through` is the `activity.seq` of the read the page
// rendered, so a change that landed since stays unread.
export function boardTaskReadPOST(req: Request, res: Response): void {
  try {
    const reader = ownWriterOf(req)
    if (!reader) {
      res.status(403).json({ error: 'person_only' })
      return
    }
    const parsed = markTaskReadBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    if (!getTask(db, taskId)) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    res.json({ ok: true, ...markTaskRead(db, reader, taskId, parsed.data.through) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/inbox/read ──────────────────────────────────────────────
// Mark everything read, or one team's tasks, through what the page knew of.
export function boardInboxReadPOST(req: Request, res: Response): void {
  try {
    const reader = ownWriterOf(req)
    if (!reader) {
      res.status(403).json({ error: 'person_only' })
      return
    }
    const parsed = markAllReadBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const { through, teamId } = parsed.data
    markAllTasksRead(getDb(), reader, through, teamId ? { teamId } : {})
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
