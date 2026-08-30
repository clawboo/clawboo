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
  listConnectors,
} from '@clawboo/db'
import {
  CONNECT_REFUSAL_COPY,
  CONNECTOR_DEFINITIONS,
  cleanPastedSecret,
  connectRefusal,
  explainConnectFailure,
  connectorBySlug,
  launchArgsSatisfied,
  resolveLaunchArgs,
  type ConnectorDefinition,
} from '@clawboo/connector-catalog'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
  resolveConnectorCredentials,
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
import { isTransient, retryTransient } from '../lib/connectors/transientRetry'

/**
 * Resolve a slug to a definition, custom entries included.
 *
 * One lookup for every route, so a custom connector cannot end up on a different
 * code path from a catalog one and grow its own bugs.
 */
function findDefinition(slug: string): ConnectorDefinition | null {
  return connectorBySlug(slug) ?? customConnectorBySlug(getDb(), slug)
}

/** Everything browsable: the committed catalog plus the operator's own entries. */
function allDefinitions(): ConnectorDefinition[] {
  return [...CONNECTOR_DEFINITIONS, ...listCustomConnectors(getDb()).map(toDefinition)]
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
    await disconnectConnector(connectorInstanceId(slug), getDb())
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
  // Hoisted so the catch can NAME the connector. A failure sentence that cannot
  // say which connector failed is barely better than the raw error it replaced.
  let failedName = 'This connector'
  try {
    const def = findDefinition((req.params['slug'] as string | undefined) ?? '')
    if (!def) {
      res.status(404).json({ error: 'no such connector' })
      return
    }
    failedName = def.displayName
    const launch = def.launch
    if (launch.transport !== 'streamable-http') {
      res.status(400).json({ error: 'only remote connectors sign in' })
      return
    }
    // Read out here: the narrowing above does not survive into the closure below.
    const launchUrl = launch.url
    const scopes = def.auth?.scopes
    // RETRIED, because this is three network round trips (discovery, dynamic
    // registration, and the provider's own metadata) and any one of them
    // dropping used to surface as a raw `TypeError: fetch failed` on a button
    // that had just been pressed. Measured against a live provider, the fourth
    // attempt is what succeeded.
    const { authorizeUrl } = await retryTransient(() =>
      beginAuthorization(def.slug, launchUrl, scopes),
    )
    res.json({ ok: true, authorizeUrl })
  } catch (err) {
    // 502: the failure is almost always the provider's discovery or registration
    // endpoint, not a fault in this server, and "GitHub does not support dynamic
    // registration" is a sentence the operator can act on.
    res.status(502).json({
      error: isTransient(err)
        ? `Could not reach ${failedName}. The request did not leave this machine, so this is network rather than the connector.`
        : `${failedName} could not start sign-in. ${String(redactValue(String(err))).slice(0, 200)}`,
    })
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
    await disconnectConnector(connectorInstanceId(slug), getDb())
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

/**
 * Which connectors already have everything they asked for.
 *
 * ONE request for the whole shelf, because the alternative is one per card and
 * the card is the surface that must not stall. It exists so the price on a tile
 * is TRUE rather than merely typical: without it a connector whose key the
 * operator entered last week still reads "Needs a key", which is the same class
 * of lie as offering a Connect the server would refuse.
 *
 * Presence only. No value, no token, and no per-connector detail: that is what
 * the per-slug route is for, and widening this one would turn a list the panel
 * polls into a credential surface.
 */
export function connectorsConfiguredGET(_req: Request, res: Response): void {
  try {
    const slugs: string[] = []
    const supplied: string[] = []
    for (const def of allDefinitions()) {
      const state = configState(def)
      if (state.satisfied) slugs.push(def.slug)
      // TWO DIFFERENT FACTS, and conflating them mislabelled the shelf. A
      // zero-input connector is `satisfied` the moment it exists, having asked
      // for nothing; it is not something the operator put anything into. The
      // "Yours" filter needs the second question, so it gets its own answer:
      // did a person actually hand this connector a credential or a path.
      if (state.credentials.some((c) => c.present) || state.argument !== null)
        supplied.push(def.slug)
    }
    res.json({ ok: true, slugs, supplied })
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
  // A BEARER remote is answered by its credential, not by the OAuth store. The
  // two slots are disjoint (`connector:<slug>:<KEY>` versus
  // `connector-oauth-tokens:<slug>`), so asking `isAuthorized` about an entry
  // that never runs the sign-in flow returns false forever. That made GitHub
  // permanently unsatisfied here while `connectorsConnectPOST` would have
  // accepted it: the card withheld an action the server allows, which is the
  // forbidden half of this feature's one invariant.
  const authorized = remote && def.auth.kind !== 'bearer' ? isAuthorized(def.slug) : true
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
      // THE SAME CLEANER THE FIELD RUNS. A trailing newline, a `Bearer ` prefix
      // copied out of a curl example, or the quotes off a shell export all look
      // correct in a password field and all fail at the vendor. Applied here too
      // rather than trusting the browser: this route is reachable without it.
      const cleaned = cleanPastedSecret(value)
      if (cleaned.length === 0) clearConnectorCredential(def.slug, key)
      else setConnectorCredential(def.slug, key, cleaned)
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

// GET /api/connectors: what is live right now.
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
  // Hoisted so the catch below can NAME the connector. A failure sentence that
  // cannot say which connector failed is barely better than the raw error.
  let failedName = 'This connector'
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
    failedName = def.displayName
    // The SAME predicate the browser renders. A client-side copy would drift,
    // and the first symptom would be a tile offering a button the server refuses.
    // Both solvable halves are evaluated HERE, because only the server can see
    // the vault and the settings store; the predicate itself stays browser-safe.
    const argument = getConnectorArgument(getDb(), def.slug)
    const launch = def.launch
    const remote = launch.transport === 'streamable-http'
    // A remote connector authenticates one of two ways, and only one of them is
    // OAuth. A BEARER entry takes a token the operator pasted, so the sign-in
    // machinery is skipped entirely: discovery would fail against a provider
    // that publishes no registration endpoint, which is the exact reason the
    // entry is a bearer one.
    const bearer = remote && def.auth.kind === 'bearer'
    // Resolved BEFORE the refusal check, because a refreshable-but-expired token
    // still counts as authorized and this is what refreshes it.
    const accessToken = remote && !bearer ? await getAccessToken(def.slug, launch.url) : null
    const refusal = connectRefusal(
      def,
      credentialsSatisfied(def.slug, def.auth.inputs),
      launchArgsSatisfied(def, argument ?? undefined),
      // A bearer entry's readiness is a credential question, which the first
      // argument already answered. Only an OAuth remote needs a token here.
      !remote || bearer || accessToken !== null,
    )
    if (refusal) {
      res.status(422).json({ error: CONNECT_REFUSAL_COPY[refusal], reason: refusal })
      return
    }

    const db: ClawbooDb = getDb()
    // RETRIED ON A DROPPED REQUEST, not on a refusal. A remote handshake that
    // never left the machine is the single most common failure on this route,
    // and making the operator press Connect again to paper over it is how a
    // working connector came to look broken. A provider that ANSWERED with a
    // rejection is not retried: that answer will not change.
    const { connector, display } = await retryTransient(() =>
      connectConnector(db, {
        ...toConnectable(def, resolveLaunchArgs(def, argument ?? undefined)),
        // The CALLBACK, not the string resolved above. `getAccessToken` refreshes
        // an expired token, so consulting it per request is what keeps a
        // long-lived connection working instead of turning every call into an
        // opaque 401 once the first token expires.
        // A CALLBACK in both cases, never a resolved string. For OAuth that is what
        // makes a refresh reach the next call; for a bearer it is what makes a
        // rotated token take effect without a reconnect.
        ...(bearer
          ? {
              accessToken: (): string | null =>
                resolveConnectorCredentials(def.slug, def.auth.inputs)[
                  def.auth.inputs.find((i) => i.required)?.key ?? def.auth.inputs[0]?.key ?? ''
                ] ?? null,
            }
          : remote && accessToken
            ? { accessToken: (): Promise<string | null> => getAccessToken(def.slug, launch.url) }
            : {}),
      }),
    )
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
    //
    // TRANSLATED, and redacted BEFORE translating: the raw text can carry a
    // token through a child's stderr, and the sentence is built from the safe
    // version. `detail` keeps the original for anyone debugging a real spawn
    // problem, one line below rather than instead of the explanation.
    const failure = explainConnectFailure(String(redactValue(String(err))), failedName)
    res.status(502).json({ error: failure.message, detail: failure.detail })
  }
}

// POST /api/connectors/:slug/disconnect
export async function connectorsDisconnectPOST(req: Request, res: Response): Promise<void> {
  try {
    const slug = (req.params['slug'] as string | undefined) ?? ''
    const closed = await disconnectConnector(connectorInstanceId(slug), getDb())
    if (!closed) {
      res.status(404).json({ error: 'connector is not connected' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// ─── Path suggestions ──────────────────────────────────────────────────────

/**
 * Real paths for the two connectors that ask for one.
 *
 * SERVER-COMPUTED so every chip is a path that exists on this machine right
 * now. The browser cannot know that, and a suggestion that 404s on save is
 * worse than a bare text field: it teaches the user the chips are decoration.
 * For `filesystem` the offers are the folders people actually mean; for
 * `sqlite` it is a shallow walk for database files, because the argument is a
 * file that must already exist and typing its absolute path from memory is
 * the single most error-prone input on the whole surface.
 *
 * Read-only by construction: nothing here opens, writes, or stats deeper than
 * the walk below, and the walk never follows symlinks out of the tree.
 */
export function connectorsPathSuggestionsGET(req: Request, res: Response): void {
  try {
    const slug = String(req.query['slug'] ?? '')
    const def = connectorBySlug(slug)
    if (!def?.userArgument) {
      res.status(404).json({ error: 'that connector does not take a path' })
      return
    }
    const suggestions: { label: string; path: string }[] = []
    const seen = new Set<string>()
    const offer = (label: string, p: string, wantDir: boolean): void => {
      try {
        const st = statSync(p)
        if (wantDir ? st.isDirectory() : st.isFile()) {
          if (!seen.has(p)) {
            seen.add(p)
            suggestions.push({ label, path: p })
          }
        }
      } catch {
        /* not there: not offered */
      }
    }

    if (slug === 'sqlite') {
      // Depth-2 walk from where clawboo was launched, for files that look like
      // databases. Capped, sorted for a stable order, symlinks not followed.
      const root = process.cwd()
      const found: string[] = []
      const walk = (dir: string, depth: number): void => {
        if (depth > 2 || found.length >= 25) return
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue
          const full = path.join(dir, e.name)
          if (e.isFile() && /\.(db|sqlite|sqlite3)$/i.test(e.name)) found.push(full)
          else if (e.isDirectory()) walk(full, depth + 1)
        }
      }
      walk(root, 0)
      for (const f of found.sort().slice(0, 5)) offer(path.basename(f), f, false)
    } else {
      offer('Where clawboo runs', process.cwd(), true)
      const home = homedir()
      offer('Documents', path.join(home, 'Documents'), true)
      offer('Desktop', path.join(home, 'Desktop'), true)
      offer('Downloads', path.join(home, 'Downloads'), true)
    }

    res.json({ ok: true, suggestions: suggestions.slice(0, 5) })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// ─── Boot restore ────────────────────────────────────────────────────────────

/**
 * Reconnect the connectors the operator left running.
 *
 * WHY IT LIVES HERE, in an api module rather than a lib one. Restoring is the
 * connect recipe with no human present: the same definition lookup, the same
 * launch argument, the same credential and token resolution, and above all the
 * SAME refusal predicate. Somewhere else it would be a second copy of that
 * recipe, and the first thing to drift would be the refusal, which is what stops
 * a connector spawning with a credential it no longer has.
 *
 * NOT AWAITED BY BOOT. A cold `npx` can hold a handshake open for the better
 * part of a minute; the server must be answering requests long before that.
 * Every connector is attempted independently so one dead server cannot strand
 * the rest, and a failure is left to the ordinary health path rather than
 * retried in a loop nobody asked for.
 */
export async function restoreConnectorsAtBoot(db: ClawbooDb): Promise<number> {
  let restored = 0
  for (const row of listConnectors(db)) {
    // ONLY WHAT THE OPERATOR LEFT ON. `desiredState` is the one field that can
    // tell a graceful shutdown from a deliberate Disconnect; health cannot,
    // because neither path writes it.
    if (row.desiredState !== 'connected') continue

    const def = findDefinition(row.slug)
    if (!def) continue

    try {
      const launch = def.launch
      const remote = launch.transport === 'streamable-http'
      const bearer = remote && def.auth.kind === 'bearer'
      const argument = getConnectorArgument(db, def.slug)
      const accessToken = remote && !bearer ? await getAccessToken(def.slug, launch.url) : null

      // The SAME predicate the Connect button answers to. A connector whose key
      // was removed, or whose sign-in has lapsed, must stay down rather than
      // spawn and fail: the shelf already knows how to say why.
      if (
        connectRefusal(
          def,
          credentialsSatisfied(def.slug, def.auth.inputs),
          launchArgsSatisfied(def, argument ?? undefined),
          !remote || bearer || accessToken !== null,
        )
      ) {
        continue
      }

      // RETRIED LIKE THE BUTTON IS. A remote handshake that never left the
      // machine is the most common failure on this path, and a boot is when it
      // is most likely: the network is often still coming up. Without this the
      // one connector most prone to a transient failure is exactly the one that
      // does not come back, and the operator is told to reconnect it by hand
      // again. Only transport failures retry; a refusal is an answer.
      await retryTransient(() =>
        connectConnector(
          db,
          {
            ...toConnectable(def, resolveLaunchArgs(def, argument ?? undefined)),
            ...(remote && accessToken
              ? { accessToken: (): Promise<string | null> => getAccessToken(def.slug, launch.url) }
              : {}),
          },
          // NOBODY IS LOOKING AT THIS ONE. A press of Connect re-consents to the
          // spec on screen; a boot does not, so the grant pins are left alone
          // and a spec that changed while we were down still reads as drift.
          { restoring: true },
        ),
      )
      restored += 1
    } catch {
      // One connector that will not come up must not stop the others, and a
      // restore is not a place to surface an error nobody asked for. The shelf
      // reports it as disconnected, which is the truth.
    }
  }
  return restored
}
