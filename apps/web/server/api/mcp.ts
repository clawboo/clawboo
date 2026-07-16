// ─── MCP Streamable-HTTP mount + attach-config helper ──────────
// The in-process HTTP transport for the three MCP servers (so the API server
// supervises them and HTTP clients can attach), plus a config-snippet endpoint
// so clawboo "hosts" the connection setup.

import type { IncomingMessage } from 'node:http'
import path from 'node:path'

import {
  createDb,
  resolveEmbeddingProvider,
  resolveRoomForTeam,
  type DbTeamChat,
  type EmbeddingProvider,
  type MemoryScope,
} from '@clawboo/db'
import {
  buildAttachConfig,
  createMemoryServer,
  createStreamableHttpHandlers,
  createTasksServer,
  createTeamChatServer,
  createToolsServer,
  MCP_SERVER_NAMES,
  type McpHttpHandlers,
  type McpRuntime,
  type McpServerName,
  type McpTransport,
  type TeamChatBoundIdentity,
} from '@clawboo/mcp'
import type { Request, Response } from 'express'

import { getDbPath } from '../lib/db'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { emitEvent } from '../lib/obs/emit'

// The memory server wants an embedding provider; resolve once (a network probe)
// and let the factory read the cached value. First HTTP session may be FTS-only.
let cachedEmbed: EmbeddingProvider | null = null
let embedKicked = false
function kickEmbedResolve(): void {
  if (embedKicked) return
  embedKicked = true
  void resolveEmbeddingProvider()
    .then((p) => {
      cachedEmbed = p
    })
    .catch(() => {
      cachedEmbed = null
    })
}

/** Read the run's authoritative scope from the Memory attach URL query params
 *  (`scopeTeamId`/`scopeAgentId`/`scopeTenantId`). Each runtime's per-run attach
 *  URL carries these so the MCP session binds to the team/agent — the model can
 *  neither widen its visibility nor mis-tag a save. Absent ⇒ unbound (legacy).
 *  Exported for unit testing. */
export function parseBoundScope(req?: IncomingMessage): MemoryScope | undefined {
  if (!req?.url) return undefined
  let params: URLSearchParams
  try {
    params = new URL(req.url, 'http://localhost').searchParams
  } catch {
    return undefined
  }
  const teamId = params.get('scopeTeamId')
  const agentId = params.get('scopeAgentId')
  const tenantId = params.get('scopeTenantId')
  if (!teamId && !agentId && !tenantId) return undefined
  return {
    ...(teamId ? { teamId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(tenantId ? { tenantId } : {}),
  }
}

/** Read the run's authoritative TeamChat binding from the attach URL query params
 *  (`roomTeamId` / `postAuthorAgentId`). The URL is clawboo-written config, so this
 *  identity cannot be spoofed via tool args (the anti-spoof property). Absent ⇒
 *  unbound (the raw stdio bin / external attach passes identity in args).
 *  Exported for unit testing. */
export function parseTeamChatBinding(req?: IncomingMessage): TeamChatBoundIdentity | undefined {
  if (!req?.url) return undefined
  let params: URLSearchParams
  try {
    params = new URL(req.url, 'http://localhost').searchParams
  } catch {
    return undefined
  }
  const teamId = params.get('roomTeamId')
  const agentId = params.get('postAuthorAgentId')
  if (!teamId || !agentId) return undefined
  // `delegate=1` is written EXCLUSIVELY by serverDeliver (an orchestrator-driven
  // run) — it exposes the `team_delegate` signal tool on this session. A merely
  // team-scoped session (e.g. an executorRunner board-task run) must not get it:
  // nothing observes delegation there (see TeamChatBoundIdentity.delegate).
  const delegate = params.get('delegate') === '1'
  return { agentId, teamId, roomId: resolveRoomForTeam(teamId), ...(delegate ? { delegate } : {}) }
}

let handlers: Record<McpServerName, McpHttpHandlers> | null = null
function getHandlers(): Record<McpServerName, McpHttpHandlers> {
  if (handlers) return handlers
  kickEmbedResolve()
  handlers = {
    tasks: createStreamableHttpHandlers(() => createTasksServer(createDb(getDbPath()))),
    memory: createStreamableHttpHandlers((req) =>
      createMemoryServer(createDb(getDbPath()), cachedEmbed, { boundScope: parseBoundScope(req) }),
    ),
    tools: createStreamableHttpHandlers(() => createToolsServer(createDb(getDbPath()))),
    teamchat: createStreamableHttpHandlers((req) => {
      const db = createDb(getDbPath())
      return createTeamChatServer(db, {
        boundIdentity: parseTeamChatBinding(req),
        onPost: (post: DbTeamChat) =>
          emitEvent(db, {
            kind: 'team_chat_post',
            teamId: post.teamId,
            agentId: post.authorAgentId,
            data: {
              roomId: post.roomId,
              seq: post.seq,
              authorAgentId: post.authorAgentId,
              postKind: post.kind,
            },
          }),
      })
    }),
  }
  return handlers
}

// ── Liveness supervisor hooks ──────────────────────────────────
/** Build the HTTP handlers + kick the embedding resolve at boot, so the first
 *  attach is fast and any init error surfaces in the boot log. */
export function prewarmMcp(): void {
  getHandlers()
}

/** Drop the cached handlers + embedding so the next attach rebuilds them clean —
 *  the supervisor's recovery action when a server health-probe fails. */
export function resetMcpHandlers(): void {
  handlers = null
  embedKicked = false
  cachedEmbed = null
}

function makePost(server: McpServerName) {
  return (req: Request, res: Response): void => {
    void getHandlers()
      [server].handlePost(req, res, req.body)
      .catch((err: unknown) => {
        if (!res.headersSent) res.status(500).json({ error: String(err) })
      })
  }
}

function makeSession(server: McpServerName) {
  return (req: Request, res: Response): void => {
    void getHandlers()
      [server].handleSessionRequest(req, res)
      .catch((err: unknown) => {
        if (!res.headersSent) res.status(500).json({ error: String(err) })
      })
  }
}

export const mcpTasksPost = makePost('tasks')
export const mcpTasksSession = makeSession('tasks')
export const mcpMemoryPost = makePost('memory')
export const mcpMemorySession = makeSession('memory')
export const mcpToolsPost = makePost('tools')
export const mcpToolsSession = makeSession('tools')
export const mcpTeamchatPost = makePost('teamchat')
export const mcpTeamchatSession = makeSession('teamchat')

// GET /api/mcp/config?runtime=&server=&transport= — emit the attach snippet.
export function mcpConfigGET(req: Request, res: Response): void {
  try {
    const server = (
      typeof req.query['server'] === 'string' ? req.query['server'] : 'tasks'
    ) as McpServerName
    if (!MCP_SERVER_NAMES.includes(server)) {
      res.status(400).json({ error: `unknown server: ${server}` })
      return
    }
    const runtime = (
      typeof req.query['runtime'] === 'string' ? req.query['runtime'] : 'claude-code'
    ) as McpRuntime
    const transport = (
      typeof req.query['transport'] === 'string' ? req.query['transport'] : 'http'
    ) as McpTransport

    // Build the http attach base from the server-trusted loopback port, NOT the client
    // `Host` header — a forged Host would otherwise redirect a runtime's MCP traffic.
    // Mirrors the runtimes.ts / teamChat.ts spawn paths (the last Host-header instance).
    const httpBaseUrl =
      loopbackMcpBaseUrl(req) ?? `http://127.0.0.1:${process.env['CLAWBOO_API_PORT'] ?? '18790'}`
    // The built stdio bin path (operator sets CLAWBOO_MCP_BIN_DIR for the smoke).
    const binDir = process.env['CLAWBOO_MCP_BIN_DIR']
    const binPath = binDir ? path.join(binDir, `${server}.js`) : undefined

    res.json({
      ok: true,
      config: buildAttachConfig({
        runtime,
        server,
        transport,
        httpBaseUrl,
        binPath,
        dbPath: getDbPath(),
      }),
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
