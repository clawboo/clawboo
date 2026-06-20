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
  createDb,
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

import type { NativeToolOutcome } from './fileTools'

export interface McpBridgeOptions {
  dbPath: string
  /** The calling agent (recorded in broker audit + approvals; the TeamChat author). */
  agentId?: string
  /** Which servers to attach. */
  enable: { tasks: boolean; memory: boolean; tools: boolean; teamchat?: boolean }
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
  /** Test seam — defaults to the real factories. */
  makeDb?: (path: string) => ClawbooDb
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

  const db = (opts.makeDb ?? createDb)(opts.dbPath)
  const clients: InMemoryMcpClient[] = []
  if (enable.tasks)
    clients.push(await connectInMemoryClient(createTasksServer(db), 'clawboo-native'))
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
        createToolsServer(db, { agentId: opts.agentId }),
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

  /** name → owning client; first registration wins (collision skipped). */
  const routes = new Map<string, InMemoryMcpClient>()
  const defs: McpToolInfo[] = []
  for (const client of clients) {
    for (const tool of await client.listTools()) {
      if (routes.has(tool.name)) continue
      routes.set(tool.name, client)
      defs.push(tool)
    }
  }
  defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return {
    async listTools(): Promise<McpToolInfo[]> {
      return defs
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
