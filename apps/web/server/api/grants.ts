// ─── Grants REST surface ──────────────────────────────────────
// The server half of the Ghost Graph's connector gestures. Every route here is
// pinned to an ALREADY-SHIPPED caller in apps/web/src/features/graph/operations/,
// so a change to a request or response shape is a wire break, not a refactor:
//
//   POST /api/grants              <- grantConnector.ts   (drag a tile onto a Boo)
//   POST /api/grants/:id/revoke   <- revokeGrant.ts       (Detach)
//   POST /api/grants/:id/resume   <- revokeGrant.ts       (the 8-second Undo)
//   GET  /api/grants              <- no shipped caller; the inspector's read
//
// SECURITY POSTURE, STATED PLAINLY. There is no caller identity on any
// state-changing route in this server: `getUserId` returns null unconditionally,
// the origin guard admits any request with no Origin (which is what a local curl
// or a spawned runtime sends), and the access gate is off unless
// STUDIO_ACCESS_TOKEN is set. So a local process can mint and widen its own
// grant. That is not a regression these routes introduce -- every REST write has
// the property -- but this is the first surface where it is a privilege
// boundary, so `granted_by` is written null rather than fabricating an actor,
// and nothing here may treat "the request reached this handler" as operator
// intent.

import {
  createGrantBody,
  getGrant,
  listGrants,
  resumeGrant,
  revokeGrant,
  revokeGrantBody,
  upsertGrant,
} from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDb } from '../lib/db'
import { redactValue } from '../lib/redact'

// GET /api/grants?subjectId=
export function grantsListGET(req: Request, res: Response): void {
  try {
    const subjectId =
      typeof req.query['subjectId'] === 'string' ? req.query['subjectId'] : undefined
    res.json({ ok: true, grants: listGrants(getDb(), subjectId ? { subjectId } : {}) })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// POST /api/grants
export function grantsCreatePOST(req: Request, res: Response): void {
  try {
    const parsed = createGrantBody.safeParse(req.body)
    if (!parsed.success) {
      // `{ error }` is the shape grantConnector.ts reads to build its toast; a
      // bare status would render as "HTTP 400" to the user.
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const b = parsed.data
    const grant = upsertGrant(getDb(), {
      subjectKind: b.subjectKind,
      subjectId: b.subjectId ?? null,
      capabilityKind: b.capabilityKind,
      connectorId: b.connectorId ?? null,
      capabilityId: b.capabilityId ?? null,
      mode: b.mode,
      approvalPolicy: b.approvalPolicy,
      toolAllow: b.toolAllow,
      toolDeny: b.toolDeny,
      // Passed through ONLY when present. The shipped client sends neither, and
      // the repository's update set is presence-gated so a re-share cannot clear
      // a time-box or a ceiling an operator set.
      ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt } : {}),
      ...(b.callCeilingPerHour !== undefined ? { callCeilingPerHour: b.callCeilingPerHour } : {}),
      origin: 'operator',
    })
    res.json({ ok: true, grant })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// POST /api/grants/:id/revoke
export function grantsRevokePOST(req: Request, res: Response): void {
  try {
    // The shipped caller sends no body at all, which arrives as `undefined`
    // rather than `{}`. Parsing that directly would 400 every Detach.
    const parsed = revokeGrantBody.safeParse(req.body ?? {})
    const reason = parsed.success ? (parsed.data.reason ?? null) : null

    const id = (req.params['id'] as string | undefined) ?? ''
    const grant = revokeGrant(getDb(), id, reason)
    if (!grant) {
      res.status(404).json({ error: 'grant not found' })
      return
    }
    res.json({ ok: true, grant })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// POST /api/grants/:id/resume — the Undo behind the Detach toast.
export function grantsResumePOST(req: Request, res: Response): void {
  try {
    const id = (req.params['id'] as string | undefined) ?? ''
    const db = getDb()
    const grant = resumeGrant(db, id)
    if (!grant) {
      // Distinguish "never existed" from "the undo window closed", because the
      // toast tells the user to grant it again and that advice is only correct
      // for the second case.
      const exists = getGrant(db, id) !== null
      res.status(exists ? 409 : 404).json({
        error: exists ? 'the undo window has closed' : 'grant not found',
      })
      return
    }
    res.json({ ok: true, grant })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
