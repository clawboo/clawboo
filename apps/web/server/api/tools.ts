// ─── Tools broker REST surface ────────────────────────────────
// The UI-facing half of the tools dual surface: list tools + their availability
// (so the Ghost Graph can grey unavailable ones), the pending tool-approval
// queue + resolve, and the audit log.

import {
  createBuiltinRegistry,
  defaultAvailabilityContext,
  listAudit,
  listPendingApprovals,
  resolveApproval,
  resolveApprovalBody,
  toolCallApprovals,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { getDb } from '../lib/db'
import { getRegistry } from '../lib/agentSource'
import { resolveExecApproval } from '../lib/agentSource/execApprovalSurface'
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
export function toolsApprovalResolvePOST(req: Request, res: Response): void {
  try {
    const parsed = resolveApprovalBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const id = (req.params['id'] as string | undefined) ?? ''
    const db = getDb()

    // ── Two kinds of approval, released two different ways ──────────────────
    //
    // A `tool` approval is held by THIS process: a promise blocked inside
    // `waitForApproval`, which `resolveApproval` releases. An `exec` approval is
    // held by the GATEWAY, and the only thing that releases it is
    // `exec.approval.resolve`.
    //
    // Routing both down the local path would mark the card answered while the
    // Gateway went on holding the command, with nothing on screen to reveal it:
    // the same lie the surface's Gateway-first ordering exists to prevent, simply
    // reintroduced one layer up. Dispatching on the stored `kind` is why that
    // column is explicit rather than inferred.
    const row = db
      .select({ kind: toolCallApprovals.kind })
      .from(toolCallApprovals)
      .where(eq(toolCallApprovals.id, id))
      .get()
    if (!row) {
      res.status(404).json({ error: 'approval not found' })
      return
    }

    if (row.kind === 'exec') {
      // OpenClaw's own vocabulary. Its allow-always writes ITS allowlist, which
      // is the only place a durable exec grant can live.
      const decision =
        parsed.data.decision === 'deny'
          ? 'deny'
          : parsed.data.decision === 'allow_always'
            ? 'allow-always'
            : 'allow-once'
      void resolveExecApproval(getRegistry().source, id, decision)
        .then((out) => {
          if (!out.ok) {
            res.status(502).json({ error: 'the Gateway did not accept that decision' })
            return
          }
          // `alreadyResolved` is a normal race, not a failure: the same card is
          // deliberately open in the browser tab too.
          res.json({ ok: true, kind: 'exec', alreadyResolved: out.alreadyResolved ?? false })
        })
        // The try/catch around this handler returned long before the promise
        // settled, so a rejection here answers nobody: the card would spin until
        // the socket gave up, with no way to tell whether the Gateway took the
        // decision. `resolveExecApproval` guards its own RPC but not the mirror
        // write that follows it.
        .catch((err) => {
          res.status(500).json({ error: redactValue(String(err)) })
        })
      return
    }

    const updated = resolveApproval(db, id, parsed.data.decision)
    if (!updated) {
      res.status(404).json({ error: 'approval not found' })
      return
    }
    res.json({ ok: true, approval: updated })
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
