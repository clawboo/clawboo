// In-process MCP bridge — how a native conversation consumes the shared spine
// (Tasks / Memory / Tools) without spawning a stdio server to call itself.
// One MCP SDK Client per enabled server over a linked in-memory transport pair
// (the liveness-probe precedent, held open for the conversation's lifetime).
// The servers wrap the same SQLite cores every other runtime reaches over
// HTTP/stdio, so the broker's availability/approval/audit pipeline applies to
// native tool calls identically. Tool names are served UNPREFIXED (they are
// already distinct across the three servers); a routing map remembers which
// client owns each name, and a later duplicate name is skipped so routing
// stays unambiguous.

import {
  resolveEmbeddingProvider,
  resolveRoomForTeam,
  type ClawbooDb,
  type DbTeamChat,
  type EmbeddingProvider,
  type MemoryScope,
} from '@clawboo/db'
import {
  connectInMemoryClient,
  createMemoryServer,
  createTasksServer,
  createTeamChatServer,
  createToolsServer,
  type InMemoryMcpClient,
  type McpToolInfo,
} from '@clawboo/mcp'

import { connectorToolsForServer, onConnectorsChanged } from '../../connectors/supervisor'
import type { NativeToolOutcome } from './fileTools'
import { BROKERED_TOOLKITS } from '@clawboo/connector-catalog'
import { connectedAppsNow } from '../../connectors/composio'

export interface McpBridgeOptions {
  /** The connection the in-process servers read/write through. The caller owns
   *  it — in the server that is the shared process handle (lib/db.ts getDb), so a
   *  native conversation costs no connection of its own. */
  db: ClawbooDb
  /** The calling agent (recorded in broker audit + approvals; the TeamChat author). */
  agentId?: string
  /** Which servers to attach. `tasks: 'read'` attaches only the board's read
   *  tools (list_tasks/get_task) — visibility without engine-racing writes. */
  enable: { tasks: boolean | 'read'; memory: boolean; tools: boolean; teamchat?: boolean }
  /**
   * The run's authoritative memory scope — bound onto the in-process Memory
   * server so native saves are team-shared + reads team-limited, matching the
   * HTTP-attached runtimes. Its teamId + `agentId` also bind the TeamChat room +
   * author identity (anti-spoof). Omitted ⇒ unbound (the model's args, if any).
   */
  memoryScope?: MemoryScope
  /** Best-effort obs hook for a native proactive `team_chat_post`. */
  onTeamChatPost?: (post: DbTeamChat) => void
  /**
   * The embedding provider for the in-process Memory server — so native saves
   * carry vectors and native `memory_search` is hybrid (parity with the HTTP /
   * stdio runtimes against the SAME shared store), not FTS-only. Omitted ⇒
   * resolved once (cached, same stack as /api/memory + auto-injection); pass
   * explicitly to inject a deterministic provider in tests.
   */
  embed?: EmbeddingProvider | null
}

// Resolve the embedding provider once per process (a reachability probe) and
// reuse — mirrors the /api/memory + auto-injection caching. Null → FTS-only.
let embedProviderPromise: Promise<EmbeddingProvider | null> | null = null
function getEmbedProvider(): Promise<EmbeddingProvider | null> {
  if (!embedProviderPromise) embedProviderPromise = resolveEmbeddingProvider().catch(() => null)
  return embedProviderPromise
}

export interface McpBridge {
  /** Provider-neutral defs (name + description + JSON-Schema args), sorted by name. */
  listTools(): Promise<McpToolInfo[]>
  /** True when `name` routes to an attached MCP server. */
  owns(name: string): boolean
  callTool(name: string, args: Record<string, unknown>): Promise<NativeToolOutcome>
  close(): Promise<void>
}

export async function connectMcpBridge(opts: McpBridgeOptions): Promise<McpBridge | null> {
  const { enable } = opts
  const teamchat = enable.teamchat === true
  if (!enable.tasks && !enable.memory && !enable.tools && !teamchat) return null

  const db = opts.db
  const clients: InMemoryMcpClient[] = []
  if (enable.tasks)
    clients.push(
      await connectInMemoryClient(
        createTasksServer(db, {
          readOnly: enable.tasks === 'read',
          // Same binding the Memory + TeamChat servers get: the run's team is
          // authoritative, so a bare `list_tasks` returns THIS team's board
          // (the agent is never told its own teamId to pass). The agentId
          // additionally enables the mid-run inbox piggyback.
          ...(opts.memoryScope?.teamId || opts.agentId
            ? {
                boundScope: {
                  ...(opts.memoryScope?.teamId ? { teamId: opts.memoryScope.teamId } : {}),
                  ...(opts.agentId ? { agentId: opts.agentId } : {}),
                },
              }
            : {}),
        }),
        'clawboo-native',
      ),
    )
  if (enable.memory) {
    // A real provider (not null) so native-authored facts store vectors and
    // native interactive search is hybrid — matching every other runtime.
    const embed = opts.embed !== undefined ? opts.embed : await getEmbedProvider()
    clients.push(
      await connectInMemoryClient(
        createMemoryServer(db, embed, { boundScope: opts.memoryScope }),
        'clawboo-native',
      ),
    )
  }
  if (enable.tools) {
    clients.push(
      await connectInMemoryClient(
        createToolsServer(db, {
          // THE BROKER'S OWN VOCABULARY, so the per-app gate can read which
          // upstream app a Composio meta-tool call is aimed at. The catalog
          // owns this list; @clawboo/db must not depend on it.
          broker: { brokeredToolkits: BROKERED_TOOLKITS },
          // What an UNBOUND caller is told it can reach. An OpenClaw session
          // carries no agent identity, so no grant is findable and the model
          // would otherwise be told nothing at all about the apps it holds.
          brokeredConnected: [...connectedAppsNow().connected],
          agentId: opts.agentId,
          // The team the run belongs to, so a TEAM-scoped grant is findable. A
          // null teamId makes every one of them invisible to the gate, and the
          // call is then denied `no-grant` with nothing explaining why.
          ...(opts.memoryScope?.teamId ? { teamId: opts.memoryScope.teamId } : {}),
          // Connector tools, so a NATIVE run can call them too. This server is
          // built in-memory rather than over HTTP, so it does not pick them up
          // from the HTTP mount: without this line connectors work for every
          // attached runtime and silently do nothing for clawboo's own.
          //
          // The FUNCTION, not its result: a run outlives a connect, so freezing
          // the list here would make a connector added mid-run invisible for the
          // rest of it.
          connectorTools: connectorToolsForServer,
          onConnectorsChanged,
        }),
        'clawboo-native',
      ),
    )
  }
  // TeamChat needs a bound author identity (the native runtime is the peer). It
  // requires both an agentId and a team — the in-process direct-subscriber path.
  if (teamchat && opts.agentId && opts.memoryScope?.teamId) {
    const teamId = opts.memoryScope.teamId
    clients.push(
      await connectInMemoryClient(
        createTeamChatServer(db, {
          boundIdentity: { agentId: opts.agentId, teamId, roomId: resolveRoomForTeam(teamId) },
          ...(opts.onTeamChatPost ? { onPost: opts.onTeamChatPost } : {}),
        }),
        'clawboo-native',
      ),
    )
  }

  // Nothing actually attached (e.g. teamchat enabled but no bound identity) → no
  // bridge, so the conversation runs with its built-in tools only.
  if (clients.length === 0) return null

  /**
   * name → owning client; first registration wins (collision skipped).
   *
   * REFRESHED rather than snapshotted. The tools server's list is live now, so a
   * connector connected after this bridge was built has to become visible
   * without the run reconnecting; a snapshot taken here would put the staleness
   * back one layer down where it is harder to see.
   */
  const routes = new Map<string, InMemoryMcpClient>()

  const refresh = async (): Promise<McpToolInfo[]> => {
    routes.clear()
    const next: McpToolInfo[] = []
    for (const client of clients) {
      for (const tool of await client.listTools()) {
        if (routes.has(tool.name)) continue
        routes.set(tool.name, client)
        next.push(tool)
      }
    }
    next.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return next
  }
  // Once up front, so `owns()` is answerable before anyone lists.
  await refresh()

  return {
    async listTools(): Promise<McpToolInfo[]> {
      return refresh()
    },
    owns(name: string): boolean {
      return routes.has(name)
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<NativeToolOutcome> {
      const client = routes.get(name)
      if (!client) return { output: `unknown tool: ${name}`, isError: true }
      try {
        return await client.callTool(name, args)
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
    async close(): Promise<void> {
      await Promise.allSettled(clients.map((c) => c.close()))
    },
  }
}
