// ─── Governance audit REST ─────────────────────────────
// Read-only view of the append-only forensic audit log (installs / approvals /
// tool calls / budget events / cap hits / verifications), filterable by agent +
// event type. Self-gates → 404 when governance is off. This is the lineage feed
// the UI + the observability layer read; there is no write endpoint (the audit
// is written in-process by the subsystems that emit events).

import type { Request, Response } from 'express'

import { createDb, listGovernanceAudit, type GovernanceEventType } from '@clawboo/db'

import { getDbPath } from '../lib/db'
import { redactJsonString } from '../lib/redact'

const EVENT_TYPES = [
  'install',
  'approval',
  'tool_call',
  'budget',
  'cap_hit',
  'verification',
  'circuit_break',
] as const
const isEventType = (v: unknown): v is GovernanceEventType =>
  typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v)

// GET /api/governance/audit?agentId=&eventType=&since=&limit=
export function governanceAuditGET(req: Request, res: Response): void {
  const agentId = typeof req.query['agentId'] === 'string' ? req.query['agentId'] : undefined
  const eventTypeRaw = req.query['eventType']
  const eventType = isEventType(eventTypeRaw) ? eventTypeRaw : undefined
  const limitRaw = Number(req.query['limit'])
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : undefined
  const sinceRaw = Number(req.query['since'])
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : undefined
  // Redact-on-display: the audit summary (JSON text) is scrubbed at write time; mask
  // its credential-shaped keys again at the rendering boundary (defense in depth).
  const audit = listGovernanceAudit(createDb(getDbPath()), {
    agentId,
    eventType,
    since,
    limit,
  }).map((row) => ({
    ...row,
    summary: redactJsonString(row.summary),
  }))
  res.json({ audit })
}
