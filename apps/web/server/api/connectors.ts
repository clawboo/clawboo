// ─── Connector lifecycle REST surface ─────────────────────────────────────
// Connect a catalog connector, see what is live, disconnect it.
//
// THE SCOPE GATE IS SERVER-SIDE, and deliberately so. The browser decides which
// tiles render a Connect button, but a route that trusted that would be trusting
// the client to enforce the very thing it is asking permission for. Four
// predicates, each with its own refusal message, because "422" tells an operator
// nothing they can act on.
//
// The same caveat as /api/grants applies and is worth restating: there is no
// caller identity on any state-changing route in this server, so a local process
// can reach these. Connecting spawns a child process, which makes that a bigger
// deal here than elsewhere. It is not a regression this route introduces, but
// nothing here may treat "the request arrived" as operator intent.

import { connectConnectorBody, type ClawbooDb } from '@clawboo/db'
import { connectorBySlug, type ConnectorDefinition } from '@clawboo/connector-catalog'
import type { Request, Response } from 'express'

import {
  connectConnector,
  connectorInstanceId,
  disconnectConnector,
  listLiveConnectors,
  type ConnectableDefinition,
} from '../lib/connectors/supervisor'
import { getDb } from '../lib/db'
import { redactValue } from '../lib/redact'

/** A placeholder the catalog tells the user to edit, which we cannot edit for them. */
const PLACEHOLDER_ARG = /(^|\/)path\/to\/|^<.+>$/

/**
 * Why a catalog entry cannot be connected by this release, or null if it can.
 *
 * Each refusal names the ACTUAL obstacle. A connector the UI offered and the
 * server then rejected with a bare status is the affordance-shaped lie the
 * connectors browser exists to refuse.
 */
export function connectRefusal(def: ConnectorDefinition): string | null {
  if (def.provenance !== 'curated') {
    return 'Only curated connectors can be connected. A community server runs as you, unsandboxed.'
  }
  if (def.launch.transport !== 'stdio') {
    return 'Remote connectors need an OAuth sign-in, which is not implemented yet.'
  }
  if (def.auth.kind !== 'none') {
    return 'This connector needs a credential, and there is no way to supply one yet.'
  }
  if (def.launch.args.some((a) => PLACEHOLDER_ARG.test(a))) {
    // Filesystem is the live example: its args end in /path/to/allowed/dir and
    // the server refuses to start without a real one.
    return 'This connector needs a path you have to fill in, and per-connector settings are not implemented yet.'
  }
  return null
}

function toConnectable(def: ConnectorDefinition): ConnectableDefinition {
  if (def.launch.transport !== 'stdio') throw new Error('not a stdio connector')
  return {
    slug: def.slug,
    displayName: def.displayName,
    provenance: def.provenance,
    launch: {
      transport: 'stdio',
      command: def.launch.command,
      args: [...def.launch.args],
      pinnedVersion: def.launch.pinnedVersion,
    },
    egressAllow: def.egressAllow,
    trifecta: def.trifecta,
  }
}

// GET /api/connectors — what is live right now.
export function connectorsListGET(_req: Request, res: Response): void {
  try {
    res.json({
      ok: true,
      connectors: listLiveConnectors().map((c) => ({
        connectorId: c.connectorId,
        slug: c.slug,
        toolCount: c.descriptors.length,
        tools: c.descriptors.map((d) => d.name),
        // Surfaced rather than swallowed: a tool that was dropped is something
        // the operator should be able to see, not wonder about.
        skipped: c.skipped,
        specHash: c.specHash,
        toolsHash: c.toolsHash,
      })),
    })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// POST /api/connectors/connect { slug }
export async function connectorsConnectPOST(req: Request, res: Response): Promise<void> {
  try {
    const parsed = connectConnectorBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const def = connectorBySlug(parsed.data.slug)
    if (!def) {
      res.status(404).json({ error: `no catalog connector named ${parsed.data.slug}` })
      return
    }
    const refusal = connectRefusal(def)
    if (refusal) {
      res.status(422).json({ error: refusal })
      return
    }

    const db: ClawbooDb = getDb()
    const { connector, display } = await connectConnector(db, toConnectable(def))
    res.json({
      ok: true,
      connectorId: connector.connectorId,
      // The RESOLVED command, so what is reported is what actually ran.
      command: display,
      tools: connector.descriptors.map((d) => d.name),
      skipped: connector.skipped,
    })
  } catch (err) {
    // A spawn or handshake failure is an ordinary outcome here, not a server
    // fault: a 502 says "the connector did not come up", which is true and
    // actionable, where a 500 would read as a clawboo bug.
    res.status(502).json({ error: redactValue(String(err)) })
  }
}

// POST /api/connectors/:slug/disconnect
export async function connectorsDisconnectPOST(req: Request, res: Response): Promise<void> {
  try {
    const slug = (req.params['slug'] as string | undefined) ?? ''
    const closed = await disconnectConnector(connectorInstanceId(slug))
    if (!closed) {
      res.status(404).json({ error: 'connector is not connected' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
