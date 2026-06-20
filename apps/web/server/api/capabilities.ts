// REST for the unified capability inventory. GET serves the ONE merged stream
// (records + per-source degradation) both the Ghost Graph and the dashboard
// consume. POST /:action is manageability-gated: install/enable/disable route to
// the owning source's write() (observe-only → 422); `approve` reuses the existing
// approval handshake (resolveApproval) — no second approval path. Writes are
// audited inside the source adapters (the existing tool-broker audit log, not forked here).

import {
  UnknownCapabilityError,
  UnsupportedCapabilityWriteError,
  type CapabilityInstallSpec,
} from '@clawboo/capability-registry'
import { agents, createDb, getCapability, resolveApproval } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { getDbPath } from '../lib/db'
import { rowToRecord } from '../lib/capabilitySource/mapper'
import { getCapabilityMultiplexer } from '../lib/capabilitySource/registry'
import { loadCapabilities, type CapabilityFilter } from '../lib/capabilitySource/service'
import { redactValue } from '../lib/redact'

function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

// ─── GET /api/capabilities?runtime=&kind=&scope=&agentId= ───────────────────
export async function capabilitiesListGET(req: Request, res: Response): Promise<void> {
  try {
    const filter: CapabilityFilter = {}
    const runtime = strParam(req.query['runtime'])
    const kind = strParam(req.query['kind'])
    const scope = strParam(req.query['scope'])
    const agentId = strParam(req.query['agentId'])
    if (runtime) filter.runtime = runtime
    if (kind) filter.kind = kind
    if (scope) filter.scope = scope
    if (agentId) filter.agentId = agentId
    const view = await loadCapabilities(filter)
    res.json(view)
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

function isInstallSpec(v: unknown): v is CapabilityInstallSpec {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return (
    typeof s['via'] === 'string' &&
    typeof s['agentId'] === 'string' &&
    typeof s['runtime'] === 'string' &&
    typeof s['kind'] === 'string' &&
    typeof s['name'] === 'string'
  )
}

// ─── POST /api/capabilities/:action  (install | enable | disable | approve) ──
export async function capabilitiesActionPOST(req: Request, res: Response): Promise<void> {
  const action = strParam(req.params['action'])
  const body = (req.body ?? {}) as Record<string, unknown>
  try {
    const db = createDb(getDbPath())

    if (action === 'approve') {
      const id = strParam(body['id'])
      const decision = body['decision']
      if (
        !id ||
        (decision !== 'allow_once' && decision !== 'allow_always' && decision !== 'deny')
      ) {
        res.status(400).json({ error: 'approve requires { id, decision }' })
        return
      }
      const updated = resolveApproval(db, id, decision)
      if (!updated) {
        res.status(404).json({ error: 'approval not found' })
        return
      }
      res.json({ ok: true, approval: updated })
      return
    }

    if (action === 'install') {
      const spec = (body['spec'] ?? body) as unknown
      if (!isInstallSpec(spec)) {
        res
          .status(400)
          .json({ error: 'install requires a valid spec { via, agentId, runtime, kind, name }' })
        return
      }
      // Explicit target-agent gate: an install writes an agent-scoped row, so an
      // unknown agentId would silently produce an INVISIBLE orphan annotation
      // (read() skips it) plus a false { ok: true }. Reject it up front (404),
      // symmetric with the enable/disable not-found path.
      const agent = db.select().from(agents).where(eq(agents.id, spec.agentId)).get()
      if (!agent) {
        res.status(404).json({ error: 'agent not found' })
        return
      }
      // Resolve the OWNING runtime authoritatively from the agent row. The client
      // sends a placeholder runtime (installSkill hardcodes 'openclaw'); the
      // multiplexer routes by `spec.via`, but the audit summary + the
      // write-response record echo `spec.runtime`, so a skill installed on a
      // non-OpenClaw agent would be mislabeled. The agent row is the source of truth.
      const resolvedSpec: CapabilityInstallSpec = { ...spec, runtime: agent.runtime }
      const record = await getCapabilityMultiplexer().write({ kind: 'install', spec: resolvedSpec })
      res.json({ ok: true, record })
      return
    }

    if (action === 'enable' || action === 'disable') {
      const id = strParam(body['id'])
      if (!id) {
        res.status(400).json({ error: `${action} requires { id }` })
        return
      }
      const row = getCapability(db, id)
      if (!row) {
        res.status(404).json({ error: 'capability not found' })
        return
      }
      // Gate symmetrically with the UI (CapabilitiesPanel actionsFor): an
      // observe-only OR a non-writable runtime-of-record capability cannot be
      // modified. `rowToRecord` derives `writable` from the row (the column isn't
      // persisted), so the server enforces the same tier the UI shows — never
      // delegating the writability check to each adapter's write() throw.
      const rec = rowToRecord(row)
      if (rec.manageability === 'observe-only' || rec.writable === false) {
        res.status(422).json({
          error: 'capability cannot be modified',
          manageability: rec.manageability,
          writable: rec.writable ?? true,
        })
        return
      }
      const record = await getCapabilityMultiplexer().write({ kind: action, id })
      res.json({ ok: true, record })
      return
    }

    res.status(400).json({ error: `unknown action: ${action ?? ''}` })
  } catch (err) {
    if (err instanceof UnknownCapabilityError) {
      res.status(404).json({ error: err.message })
      return
    }
    if (err instanceof UnsupportedCapabilityWriteError) {
      res.status(422).json({ error: err.message, manageability: err.manageability })
      return
    }
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
