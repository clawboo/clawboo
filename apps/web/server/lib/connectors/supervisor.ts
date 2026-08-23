// Connector connection lifecycle: connect, discover, hold, disconnect.
//
// The one module that owns a live connector. Everything it does is in service of
// a single invariant: a tool the model can see is a tool the broker can execute
// AND the grant gate governs. A discovered tool that reaches the registry
// without an accompanying connectorId would run ungoverned, so the two travel
// together or not at all.

import {
  connectorChildEnv,
  connectStdioConnector,
  type ConnectorSession,
  type DiscoveredTool,
} from '@clawboo/mcp'
import {
  buildConnectorDescriptor,
  namespacedToolName,
  specDigest,
  toolsDigest,
  upsertConnector,
  type ClawbooDb,
  type ToolDescriptor,
} from '@clawboo/db'

import { registerConnectorPid, unregisterConnectorPid } from '../runtimes/subprocess'
import { planConnectorSpawn } from './spawnPlan'

/** What the catalog gives us, narrowed to what a connection needs. */
export interface ConnectableDefinition {
  slug: string
  displayName: string
  provenance: 'curated' | 'community'
  launch: { transport: 'stdio'; command: string; args: string[]; pinnedVersion: string }
  egressAllow: readonly string[]
  trifecta: { readsPrivateData: boolean; ingestsUntrustedContent: boolean; canEgress: boolean }
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
}

/**
 * The identity a grant is keyed on for a clawboo-owned connector instance.
 *
 * Derived from the slug rather than from a runtime record, because this
 * connector belongs to clawboo itself rather than to any one agent's runtime
 * config. Stable across reconnects, which is what lets a grant survive one.
 */
export function connectorInstanceId(slug: string): string {
  return `conn:connector:clawboo:${slug}`
}

const live = new Map<string, LiveConnector>()

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
  if (existing) return { connector: existing, display: '' }

  const plan = planConnectorSpawn(def.launch)
  if (plan.unresolved) {
    throw new Error(`cannot find ${def.launch.command} on PATH — is Node installed?`)
  }

  const session = await connectStdioConnector({
    command: plan.command,
    args: plan.args,
    // The allowlist, never process.env.
    env: connectorChildEnv(),
  })
  // Register BEFORE anything can fail: from here on, a throw must not leak a
  // process, and the transport's own close() reaps only the direct child.
  registerConnectorPid(session.pid)

  let discovered: DiscoveredTool[]
  try {
    discovered = await session.listTools()
  } catch (err) {
    await session.close()
    unregisterConnectorPid(session.pid)
    throw new Error(`connected but could not list tools: ${(err as Error).message}`)
  }

  const descriptors: ToolDescriptor[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const tool of discovered) {
    const named = namespacedToolName(def.slug, tool.name)
    if (!named.ok) {
      // One unusable tool must not cost the whole connector. Recorded so the
      // operator can see what was dropped instead of wondering.
      skipped.push({ name: tool.name, reason: named.reason })
      continue
    }
    descriptors.push(toDescriptor(def, tool, named.name))
  }

  const spec = {
    transport: def.launch.transport,
    command: def.launch.command,
    args: def.launch.args,
  }
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
  }
  live.set(connectorId, connector)
  return { connector, display: plan.display }
}

/** Close a connector and stop tracking its process. */
export async function disconnectConnector(connectorId: string): Promise<boolean> {
  const connector = live.get(connectorId)
  if (!connector) return false
  live.delete(connectorId)
  const pid = connector.session.pid
  await connector.session.close()
  unregisterConnectorPid(pid)
  return true
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
