// ─── Tools broker REST surface ────────────────────────────────
// The UI-facing half of the tools dual surface: list tools + their availability
// (so the Ghost Graph can grey unavailable ones), the pending tool-approval
// queue + resolve, and the audit log.

import {
  createBuiltinRegistry,
  defaultAvailabilityContext,
  listAudit,
  listPendingApprovals,
  resolveApprovalBody,
} from '@clawboo/db'
import type { Request, Response } from 'express'

import { decideApproval } from '../lib/approvalDecision'
import { personOf } from '../lib/auth'
import { getDb } from '../lib/db'
import { redactJsonString, redactValue } from '../lib/redact'

// GET /api/tools — every builtin tool + its availability verdict (server-
// evaluated from the process env), for the greyed-node view.
export function toolsListGET(_req: Request, res: Response): void {
  try {
    const registry = createBuiltinRegistry()
    const ctx = defaultAvailabilityContext()
    const tools = registry.listWithAvailability(ctx).map(({ descriptor, availability }) => ({
      name: descriptor.name,
      description: descriptor.description,
      owner: descriptor.owner ?? 'core',
      risk: descriptor.risk ?? 'safe',
      available: availability.visible,
      diagnostics: availability.diagnostics,
    }))
    res.json({ ok: true, tools })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// GET /api/tools/approvals?status=pending — the pending tool-approval queue.
export function toolsApprovalsGET(_req: Request, res: Response): void {
  try {
    const db = getDb()
    // Redact-on-display: the args summary (JSON text) is scrubbed at write time; mask
    // its credential-shaped keys again at the rendering boundary (defense in depth).
    const approvals = listPendingApprovals(db).map((a) => ({
      ...a,
      argsSummary: redactJsonString(a.argsSummary),
    }))
    res.json({ ok: true, approvals })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// POST /api/tools/approvals/:id/resolve { decision }
// An `exec` approval is released by the Gateway, a `tool` one by this process;
// `decideApproval` dispatches on the stored kind.
export async function toolsApprovalResolvePOST(req: Request, res: Response): Promise<void> {
  try {
    const parsed = resolveApprovalBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const id = (req.params['id'] as string | undefined) ?? ''
    const answer = await decideApproval(getDb(), id, parsed.data.decision, {
      resolvedBy: personOf(req),
    })
    res.status(answer.status).json(answer.body)
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// GET /api/tools/audit?toolName=&limit=
export function toolsAuditGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const toolName = typeof req.query['toolName'] === 'string' ? req.query['toolName'] : undefined
    const limit = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : undefined
    // Redact-on-display: tool args/result summaries (JSON text) are scrubbed at write
    // time; mask their credential-shaped keys again at the rendering boundary (the MCP
    // tool-result inspector surface).
    const audit = listAudit(db, { toolName, limit }).map((a) => ({
      ...a,
      argsSummary: redactJsonString(a.argsSummary),
      resultSummary: redactJsonString(a.resultSummary),
    }))
    res.json({ ok: true, audit })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
