// Connector connection lifecycle: connect, discover, hold, disconnect.
//
// The one module that owns a live connector. Everything it does is in service of
// a single invariant: a tool the model can see is a tool the broker can execute
// AND the grant gate governs. A discovered tool that reaches the registry
// without an accompanying connectorId would run ungoverned, so the two travel
// together or not at all.

import {
  connectHttpConnector,
  connectorChildEnv,
  ConnectorHandshakeError,
  connectStdioConnector,
  type ConnectorSession,
  type DiscoveredTool,
} from '@clawboo/mcp'
import {
  appendEvent,
  buildConnectorDescriptor,
  ensureOwnerGrant,
  getConnector,
  namespacedToolName,
  persistDescriptorMetadata,
  repinOwnerGrant,
  specDigest,
  toolsDigest,
  upsertConnector,
  type ClawbooDb,
  type ToolDescriptor,
} from '@clawboo/db'

import { connectorInstanceIdForSlug } from '../capabilitySource/connectorIdentity'
import { killProcessTreeByPid } from '../runtimes/killTree'
import { registerConnectorPid, unregisterConnectorPid } from '../runtimes/subprocess'
import { resolveConnectorCredentials, type DeclaredInput } from './credentials'
import { forgetConnectorPid, recordConnectorPid } from './pidFile'
import { planConnectorSpawn } from './spawnPlan'

/** What the catalog gives us, narrowed to what a connection needs. */
export interface ConnectableDefinition {
  slug: string
  displayName: string
  /** Only a CURATED entry earns belief in its own tool annotations. */
  provenance: 'curated' | 'community' | 'custom'
  launch:
    | { transport: 'stdio'; command: string; args: string[]; pinnedVersion: string }
    | { transport: 'streamable-http'; url: string }
  /**
   * A bearer token for a remote connector, or a callback that produces one.
   *
   * The CALLBACK form is what survives expiry: it is consulted before every
   * request, so a refresh reaches the next tool call. A plain string is frozen
   * for the life of the session and is kept only for callers that genuinely
   * have a static token. Resolved by the caller either way, so this module
   * never touches the OAuth flow itself.
   */
  accessToken?: string | (() => string | null | Promise<string | null>)
  egressAllow: readonly string[]
  trifecta: { readsPrivateData: boolean; ingestsUntrustedContent: boolean; canEgress: boolean }
  /** Credentials the connector declared. Resolved from the vault, never ambient. */
  authInputs?: readonly DeclaredInput[]
}

export interface LiveConnector {
  connectorId: string
  slug: string
  session: ConnectorSession
  descriptors: ToolDescriptor[]
  /** Tools that could not be represented, with why. Surfaced, never swallowed. */
  skipped: { name: string; reason: string }[]
  specHash: string
  toolsHash: string
  /** The resolved command this connector was started with, for the operator record. */
  display: string
}

/**
 * The identity a grant is keyed on for a clawboo-owned connector instance.
 *
 * Delegated to `connectorIdentity`, which is also what the capability projection
 * derives from the connector source's record. Two independent spellings of this
 * string would mean the supervisor mints a grant under one id while the broker
 * looks one up under another, and the only symptom would be `no-grant` denials
 * for a connector the graph shows as perfectly healthy.
 */
export function connectorInstanceId(slug: string): string {
  return connectorInstanceIdForSlug(slug)
}

const live = new Map<string, LiveConnector>()

/** Connects that have started but not finished, so a second caller joins rather
 *  than starting a second child. Cleared in a `finally`, success or failure. */
const inFlight = new Map<string, Promise<ConnectResult>>()

/** Bind a discovered tool to the live session that serves it. */
function toDescriptor(
  def: ConnectableDefinition,
  tool: DiscoveredTool,
  name: string,
): ToolDescriptor {
  return buildConnectorDescriptor(tool, {
    name,
    // Only a CURATED entry earns belief in its own annotations: the trust comes
    // from the catalog vouching for the package, never from the server's say-so.
    trustAnnotations: def.provenance === 'curated',
    trifecta: def.trifecta,
    executor: async (args) => {
      const session = live.get(connectorInstanceId(def.slug))?.session
      if (!session) return `connector ${def.slug} is not connected`
      // A tool-reported error comes back as TEXT: the broker records it, and
      // throwing here would lose the server's own message.
      return (await session.callTool(tool.name, args)).text
    },
  })
}

export interface ConnectResult {
  connector: LiveConnector
  /** The exact command the operator was shown, for the audit trail. */
  display: string
}

/**
 * Connect a connector and discover its tools.
 *
 * Writes the `connectors` row LAST, once discovery has succeeded: a row for a
 * server that never answered would make the directory claim a connection that
 * does not exist.
 */
export async function connectConnector(
  db: ClawbooDb,
  def: ConnectableDefinition,
): Promise<ConnectResult> {
  const connectorId = connectorInstanceId(def.slug)
  const existing = live.get(connectorId)
  if (existing) return { connector: existing, display: existing.display }

  // Share one in-flight connect per connector. The `live` check above cannot do
  // this on its own: a cold start spends up to a minute inside the handshake
  // while `npx` installs, and two clicks in that window would both pass the
  // check, both spawn a child, and leave the loser tracked only by the shutdown
  // registry -- a process no Disconnect could ever reach.
  const pending = inFlight.get(connectorId)
  if (pending) return pending

  const attempt = performConnect(db, def, connectorId).finally(() => inFlight.delete(connectorId))
  inFlight.set(connectorId, attempt)
  return attempt
}

async function performConnect(
  db: ClawbooDb,
  def: ConnectableDefinition,
  connectorId: string,
): Promise<ConnectResult> {
  // Branched on the DISCRIMINANT rather than a boolean, so each side is narrowed
  // and neither can read a field the other shape does not have.
  const launch = def.launch

  // A remote connector spawns nothing: no command to resolve, no process to
  // reap. `display` is the URL, which is still the thing consent is asked for.
  const plan =
    launch.transport === 'streamable-http'
      ? { command: launch.url, args: [] as string[], display: launch.url, unresolved: false }
      : planConnectorSpawn(launch)
  if (plan.unresolved) {
    throw new Error(`cannot find ${plan.command} on PATH. Is Node installed?`)
  }

  let session: ConnectorSession
  try {
    session =
      launch.transport === 'streamable-http'
        ? await connectHttpConnector({
            url: launch.url,
            ...(def.accessToken ? { accessToken: def.accessToken } : {}),
          })
        : await connectStdioConnector({
            command: plan.command,
            args: plan.args,
            // Recorded the moment the child exists, not once the handshake
            // succeeds. A cold `npx` install can hold the handshake open for
            // the better part of a minute, and a hard stop inside that window
            // used to leave an orphan the boot reap could not see.
            onSpawn: (spawned) => {
              recordConnectorPid({
                pid: spawned,
                slug: def.slug,
                startedAt: Date.now(),
                command: plan.command,
              })
            },
            // The allowlist, never process.env. `declared` is the ONLY way a
            // credential reaches the child, and it comes from the vault rather
            // than the ambient environment.
            env: connectorChildEnv({
              declared: resolveConnectorCredentials(def.slug, def.authInputs ?? []),
            }),
          })
  } catch (err) {
    // A handshake failure still SPAWNED something, for stdio. The transport's
    // own close reaps only the direct child, so without this the real server
    // survives a connect that reported failure.
    if (err instanceof ConnectorHandshakeError && typeof err.pid === 'number') {
      killProcessTreeByPid(err.pid)
      // The durable record was written as soon as the child spawned, so it has
      // to be dropped here or the boot reap would chase a pid this connect
      // already killed.
      forgetConnectorPid(err.pid)
    }
    throw err
  }
  // Register BEFORE anything can fail: from here on, a throw must not leak a
  // process, and the transport's own close() reaps only the direct child.
  const pid = session.pid
  registerConnectorPid(pid)
  // The durable record is already written by `onSpawn` above, which fires
  // before the handshake rather than after it. Re-recorded here only for a
  // transport that never called it, so the record cannot depend on the poll
  // having caught a very short-lived spawn.
  if (typeof pid === 'number') {
    recordConnectorPid({
      pid,
      slug: def.slug,
      startedAt: Date.now(),
      // The resolved binary, for the log. Identity is decided by boot and start
      // time rather than by this.
      command: plan.command,
    })
  }

  let discovered: DiscoveredTool[]
  try {
    discovered = await session.listTools()
  } catch (err) {
    await session.close()
    if (typeof pid === 'number') {
      killProcessTreeByPid(pid)
      forgetConnectorPid(pid)
    }
    unregisterConnectorPid(pid)
    throw new Error(`connected but could not list tools: ${(err as Error).message}`)
  }

  const descriptors: ToolDescriptor[] = []
  const skipped: { name: string; reason: string }[] = []
  const claimed = new Set<string>()
  for (const tool of discovered) {
    const named = namespacedToolName(def.slug, tool.name)
    if (!named.ok) {
      // One unusable tool must not cost the whole connector. Recorded so the
      // operator can see what was dropped instead of wondering.
      skipped.push({ name: tool.name, reason: named.reason })
      continue
    }
    // A server can repeat a name, and an unstable cursor makes the paging loop
    // manufacture repeats on its own. Two identical names reach
    // `registerOrThrow`, which throws INSIDE the per-session tools-server
    // factory -- taking down every builtin tool for every HTTP-attached agent,
    // not just this connector, until someone disconnects it.
    if (claimed.has(named.name)) {
      skipped.push({ name: tool.name, reason: 'duplicate-name' })
      continue
    }
    claimed.add(named.name)
    descriptors.push(toDescriptor(def, tool, named.name))
  }
  if (session.wasTruncated()) {
    // Recorded like any other dropped tool, because an inventory that silently
    // stops at a cap is the one case where the digest below stops describing
    // the server it was taken from.
    skipped.push({ name: '(inventory)', reason: 'tool-list-truncated' })
  }

  // What the operator consented to, and therefore what drift is measured
  // against. A URL for a remote connector; a command and argv for a local one.
  //
  // THE CATALOG'S COMMAND, not the resolved absolute path. The resolved path is
  // a property of this machine at this moment: switching Node versions, or
  // installing a package manager somewhere else, moves it without anything
  // about the connector changing. Pinning it made an nvm switch look identical
  // to a rug-pull and denied every call afterwards with no way back. The argv IS
  // resolved, because the operator's launch argument is the one part of it they
  // chose and a change there is a real change of scope.
  const spec =
    launch.transport === 'streamable-http'
      ? { transport: launch.transport, url: launch.url }
      : { transport: launch.transport, command: launch.command, args: plan.args }
  const specHash = specDigest(spec)
  // Over the DISCOVERED list, including descriptions: a rug-pull that rewrites a
  // description to smuggle instructions changes nothing else.
  const toolsHash = toolsDigest(
    discovered.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  )

  upsertConnector(db, {
    id: connectorId,
    slug: def.slug,
    catalogId: def.slug,
    displayName: def.displayName,
    transport: def.launch.transport,
    spec: JSON.stringify(spec),
    specHash,
    toolsHash,
    egressAllow: JSON.stringify(def.egressAllow),
    trifecta: JSON.stringify(def.trifecta),
    health: 'ok',
    healthDetail: null,
    failures: 0,
  })

  const connector: LiveConnector = {
    connectorId,
    slug: def.slug,
    session,
    descriptors,
    skipped,
    specHash,
    toolsHash,
    display: plan.display,
  }
  // Persist a registry row per tool, attributed to its connector. Without one
  // `setToolEnabled` updates zero rows and `isToolEnabled` falls back to
  // enabled, so the per-tool kill switch silently does nothing for exactly the
  // tools most likely to need it.
  for (const descriptor of descriptors) {
    try {
      persistDescriptorMetadata(db, descriptor, connectorId)
    } catch {
      // A metadata write must not fail a connection that otherwise succeeded.
    }
  }

  // Mint the owner grant HERE rather than leaving it to the capability
  // projection. That projection runs on `GET /api/capabilities`, so a tool call
  // landing before any inventory read would deny `grant:no-grant` for a
  // connector the user had just connected -- a race whose symptom looks exactly
  // like a governance bug.
  try {
    const identity = {
      subjectKind: 'global',
      subjectId: null,
      capabilityKind: 'connector',
      connectorId,
      capabilityId: null,
    } as const
    if (!ensureOwnerGrant(db, { ...identity, specHashPin: specHash, toolsHashPin: toolsHash })) {
      // The grant already existed, and its pins describe a previous connect.
      //
      // THE SPEC PIN IS RE-PINNED, THE TOOLS PIN IS NOT, and the asymmetry is
      // the whole point. The spec is what the operator is looking at when they
      // press Connect: the command, the URL, the launch argument they just
      // typed. Consenting to it again is exactly what the click means, and
      // without this a changed argument denies every call as spec-drift forever,
      // because the automatic path is insert-only.
      //
      // The tool inventory is not on screen and was not consented to. A server
      // that rewrites a tool description to smuggle instructions changes nothing
      // else, so re-pinning it on a reconnect would erase the one signal that
      // catches a rug-pull. That drift stays, and clearing it takes a human
      // revoking the grant and granting it again.
      repinOwnerGrant(db, { ...identity, specHashPin: specHash })
    }
  } catch {
    // A grant write must not fail a connection that otherwise succeeded; the
    // projection will mint it on the next inventory read.
  }

  live.set(connectorId, connector)
  announceChange()

  // A child can die on its own: a crash, an OOM kill, a user running `pkill`.
  // Without this the entry stays in `live` forever, the capability source keeps
  // reporting it ready, its tools keep being served into every new session, and
  // a possibly-recycled pid stays in the shutdown registry.
  session.onClose(() => {
    if (live.get(connectorId) !== connector) return
    live.delete(connectorId)
    unregisterConnectorPid(pid)
    if (typeof pid === 'number') forgetConnectorPid(pid)
    markConnectorDown(db, connectorId, 'the connector process exited')
    announceChange()
  })

  return { connector, display: plan.display }
}

/**
 * Record that a connector is no longer running.
 *
 * `connectors.health` previously had exactly one writer -- the literal `'ok'` on
 * connect -- so a crashed connector's row claimed health forever. This is the
 * other end of that, and it also emits the `connector_health` event whose schema,
 * ingest allowlist and two UI renderers all already exist and had no producer.
 */
function markConnectorDown(db: ClawbooDb, connectorId: string, detail: string): void {
  try {
    const row = getConnector(db, connectorId)
    if (row) {
      upsertConnector(db, {
        ...row,
        health: 'error',
        healthDetail: detail,
        failures: row.failures + 1,
      })
    }
    appendEvent(db, {
      kind: 'connector_health',
      data: { connectorId, health: 'error', detail },
    })
  } catch {
    // Best effort: an observability write must never throw on a process-exit
    // callback, where there is nobody to catch it.
  }
}

/** Close a connector and stop tracking its process. */
export async function disconnectConnector(connectorId: string): Promise<boolean> {
  const connector = live.get(connectorId)
  if (!connector) return false
  live.delete(connectorId)
  const pid = connector.session.pid

  await connector.session.close()
  // close() signals only the DIRECT child, which for an `npx -y <pkg>` launch is
  // the wrapper. Without this the real server keeps running, and unregistering
  // the pid below would remove the last thing that could ever reap it.
  if (typeof pid === 'number') {
    killProcessTreeByPid(pid)
    forgetConnectorPid(pid)
  }
  unregisterConnectorPid(pid)
  announceChange()
  return true
}

/**
 * Anyone who wants to know when the connected set changes.
 *
 * The tools server subscribes so it can send `tools/listChanged`. Without this
 * the capability is declared and never exercised: a connector added mid-session
 * stays invisible until the client reconnects, and a disconnected one keeps
 * being offered until the model gives up calling it.
 */
const changeListeners = new Set<() => void>()

export function onConnectorsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function announceChange(): void {
  for (const listener of changeListeners) {
    try {
      listener()
    } catch {
      // One bad listener must not stop the others, and must never propagate
      // into a connect or a process-exit callback.
    }
  }
}

/** Everything currently connected, for the tools-server injection point. */
export function connectorToolsForServer(): { descriptor: ToolDescriptor; connectorId: string }[] {
  const out: { descriptor: ToolDescriptor; connectorId: string }[] = []
  for (const c of live.values()) {
    for (const descriptor of c.descriptors) out.push({ descriptor, connectorId: c.connectorId })
  }
  return out
}

export function getLiveConnector(connectorId: string): LiveConnector | null {
  return live.get(connectorId) ?? null
}

export function listLiveConnectors(): LiveConnector[] {
  return [...live.values()]
}

/** Test seam. Closes everything and clears the map. */
export async function resetConnectorsForTests(): Promise<void> {
  for (const id of [...live.keys()]) await disconnectConnector(id)
}
