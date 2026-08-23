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

import {
  connectConnectorBody,
  createCustomConnectorBody,
  setConnectorConfigBody,
  type ClawbooDb,
} from '@clawboo/db'
import {
  CONNECT_REFUSAL_COPY,
  connectRefusal,
  connectorBySlug,
  launchArgsSatisfied,
  resolveLaunchArgs,
  type ConnectorDefinition,
} from '@clawboo/connector-catalog'
import type { Request, Response } from 'express'

import {
  connectConnector,
  connectorInstanceId,
  disconnectConnector,
  listLiveConnectors,
  type ConnectableDefinition,
} from '../lib/connectors/supervisor'
import {
  clearConnectorCredential,
  credentialsSatisfied,
  credentialStatus,
  getConnectorArgument,
  setConnectorArgument,
  setConnectorCredential,
} from '../lib/connectors/credentials'
import {
  customConnectorBySlug,
  deleteCustomConnector,
  listCustomConnectors,
  saveCustomConnector,
  toDefinition,
} from '../lib/connectors/custom'
import { awaitAuthorization, beginAuthorization, getAccessToken } from '../lib/connectors/oauthFlow'
import { clearOAuth, isAuthorized } from '../lib/connectors/oauthStore'
import { getDb } from '../lib/db'
import { redactValue } from '../lib/redact'

/**
 * Resolve a slug to a definition, custom entries included.
 *
 * One lookup for every route, so a custom connector cannot end up on a different
 * code path from a catalog one and grow its own bugs.
 */
function findDefinition(slug: string): ConnectorDefinition | null {
  return connectorBySlug(slug) ?? customConnectorBySlug(getDb(), slug)
}

// POST /api/connectors/custom: point clawboo at a server of your own.
export function connectorsCustomPOST(req: Request, res: Response): void {
  try {
    const parsed = createCustomConnectorBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    // A catalog slug is reserved: shadowing one would silently replace an entry
    // we vouch for with a command we know nothing about.
    if (connectorBySlug(parsed.data.slug)) {
      res.status(409).json({ error: `${parsed.data.slug} is already a catalog connector` })
      return
    }
    saveCustomConnector(getDb(), { ...parsed.data, args: parsed.data.args })
    res.json({ ok: true, slug: parsed.data.slug })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// GET /api/connectors/custom: the operator's own entries, in catalog shape.
export function connectorsCustomGET(_req: Request, res: Response): void {
  try {
    res.json({ ok: true, connectors: listCustomConnectors(getDb()).map(toDefinition) })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// DELETE /api/connectors/custom/:slug
export async function connectorsCustomDELETE(req: Request, res: Response): Promise<void> {
  try {
    const slug = (req.params['slug'] as string | undefined) ?? ''
    // Disconnect FIRST: removing the definition of something still running would
    // orphan the process with nothing left that knows how to stop it.
    await disconnectConnector(connectorInstanceId(slug))
    if (!deleteCustomConnector(getDb(), slug)) {
      res.status(404).json({ error: 'no such custom connector' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// POST /api/connectors/:slug/authorize: start an OAuth sign-in for a remote
// connector. Returns a URL for the operator to open; the callback lands on an
// ephemeral loopback listener, never on this server.
export async function connectorAuthorizePOST(req: Request, res: Response): Promise<void> {
  try {
    const def = findDefinition((req.params['slug'] as string | undefined) ?? '')
    if (!def) {
      res.status(404).json({ error: 'no such connector' })
      return
    }
    if (def.launch.transport !== 'streamable-http') {
      res.status(400).json({ error: 'only remote connectors sign in' })
      return
    }
    const { authorizeUrl } = await beginAuthorization(def.slug, def.launch.url)
    res.json({ ok: true, authorizeUrl })
  } catch (err) {
    // 502: the failure is almost always the provider's discovery or registration
    // endpoint, not a fault in this server, and "GitHub does not support dynamic
    // registration" is a sentence the operator can act on.
    res.status(502).json({ error: redactValue(String(err)) })
  }
}

// POST /api/connectors/:slug/authorize/await: block until the sign-in finishes.
// Separate from starting it so the browser can open the URL first and then wait.
export async function connectorAuthorizeAwaitPOST(req: Request, res: Response): Promise<void> {
  try {
    await awaitAuthorization((req.params['slug'] as string | undefined) ?? '')
    res.json({ ok: true, authorized: true })
  } catch (err) {
    res.status(400).json({ error: redactValue(String(err)) })
  }
}

// DELETE /api/connectors/:slug/authorize: forget the tokens and registration.
export async function connectorAuthorizeDELETE(req: Request, res: Response): Promise<void> {
  try {
    const slug = (req.params['slug'] as string | undefined) ?? ''
    // Disconnect first: a live session is holding a token we are about to
    // forget, and leaving it running would keep using a credential the operator
    // just asked us to drop.
    await disconnectConnector(connectorInstanceId(slug))
    clearOAuth(slug)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// GET /api/connectors/:slug/config: everything an operator must supply before
// this connector can run, and whether they have.
//
// Credentials report PRESENCE only; the launch argument reports its VALUE. That
// asymmetry is deliberate: checking which folder a connector was handed is the
// entire reason for asking, while a token that could be read back would make the
// vault pointless.
export function connectorConfigGET(req: Request, res: Response): void {
  try {
    const def = findDefinition((req.params['slug'] as string | undefined) ?? '')
    if (!def) {
      res.status(404).json({ error: 'no such connector' })
      return
    }
    res.json({ ok: true, ...configState(def) })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

/** The shape both config routes return. */
function configState(def: ConnectorDefinition): {
  credentials: ReturnType<typeof credentialStatus>
  argument: string | null
  argumentSpec: ConnectorDefinition['userArgument'] | null
  authorized: boolean
  satisfied: boolean
} {
  const argument = getConnectorArgument(getDb(), def.slug)
  const remote = def.launch.transport === 'streamable-http'
  const authorized = remote ? isAuthorized(def.slug) : true
  return {
    credentials: credentialStatus(def.slug, def.auth.inputs),
    argument,
    argumentSpec: def.userArgument ?? null,
    authorized,
    satisfied:
      credentialsSatisfied(def.slug, def.auth.inputs) &&
      launchArgsSatisfied(def, argument ?? undefined) &&
      authorized,
  }
}

// PUT /api/connectors/:slug/config { values?, argument? }
export function connectorConfigPUT(req: Request, res: Response): void {
  try {
    const def = findDefinition((req.params['slug'] as string | undefined) ?? '')
    if (!def) {
      res.status(404).json({ error: 'no such connector' })
      return
    }
    const parsed = setConnectorConfigBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }

    // VALIDATE EVERYTHING FIRST, then write. Applying the argument before
    // checking the credential keys meant a request rejected with 400 had already
    // persisted half of itself, so the operator saw a failure and a changed
    // setting at the same time.
    const declared = new Set(def.auth.inputs.map((i) => i.key))
    const entries = Object.entries(parsed.data.values ?? {})
    for (const [key] of entries) {
      // Only DECLARED keys. Without this the route is a general-purpose write
      // into the vault, addressable by any local process, under a connector's
      // name -- which would let it overwrite a runtime provider key.
      if (!declared.has(key)) {
        res.status(400).json({ error: `${key} is not declared by ${def.slug}` })
        return
      }
    }

    if (parsed.data.argument !== undefined) {
      setConnectorArgument(getDb(), def.slug, parsed.data.argument)
    }
    for (const [key, value] of entries) {
      // Trimmed: a pasted token routinely carries a trailing newline, which the
      // child would otherwise receive verbatim, and a whitespace-only value
      // would report itself as present while being useless.
      const trimmed = value.trim()
      if (trimmed.length === 0) clearConnectorCredential(def.slug, key)
      else setConnectorCredential(def.slug, key, trimmed)
    }

    // Credentials come back as presence only, so this route can never be used to
    // read back a secret it was given.
    res.json({ ok: true, ...configState(def) })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

function toConnectable(def: ConnectorDefinition, args: string[]): ConnectableDefinition {
  if (def.launch.transport === 'streamable-http') {
    return {
      slug: def.slug,
      displayName: def.displayName,
      provenance: def.provenance,
      launch: { transport: 'streamable-http', url: def.launch.url },
      egressAllow: def.egressAllow,
      trifecta: def.trifecta,
    }
  }
  return {
    slug: def.slug,
    displayName: def.displayName,
    provenance: def.provenance,
    launch: {
      transport: 'stdio',
      command: def.launch.command,
      // Already resolved: a user-supplied path has been substituted or appended.
      args,
      pinnedVersion: def.launch.pinnedVersion,
    },
    egressAllow: def.egressAllow,
    trifecta: def.trifecta,
    authInputs: def.auth.inputs,
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
    const def = findDefinition(parsed.data.slug)
    if (!def) {
      res.status(404).json({ error: `no catalog connector named ${parsed.data.slug}` })
      return
    }
    // The SAME predicate the browser renders. A client-side copy would drift,
    // and the first symptom would be a tile offering a button the server refuses.
    // Both solvable halves are evaluated HERE, because only the server can see
    // the vault and the settings store; the predicate itself stays browser-safe.
    const argument = getConnectorArgument(getDb(), def.slug)
    const launch = def.launch
    const remote = launch.transport === 'streamable-http'
    // Resolved BEFORE the refusal check, because a refreshable-but-expired token
    // still counts as authorized and this is what refreshes it.
    const accessToken =
      launch.transport === 'streamable-http' ? await getAccessToken(def.slug, launch.url) : null
    const refusal = connectRefusal(
      def,
      credentialsSatisfied(def.slug, def.auth.inputs),
      launchArgsSatisfied(def, argument ?? undefined),
      !remote || accessToken !== null,
    )
    if (refusal) {
      res.status(422).json({ error: CONNECT_REFUSAL_COPY[refusal], reason: refusal })
      return
    }

    const db: ClawbooDb = getDb()
    const { connector, display } = await connectConnector(db, {
      ...toConnectable(def, resolveLaunchArgs(def, argument ?? undefined)),
      ...(accessToken ? { accessToken } : {}),
    })
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
