// ─── Attach-config helper ───────────────────────────────────────────────────
// clawboo "hosts" the MCP servers; the consuming runtime attaches them via its
// own config. This generates the exact snippet per runtime + transport, so a
// user (or the live smoke) can copy-paste a working attachment. Pure — no SDK.

export type McpRuntime = 'claude-code' | 'codex' | 'openclaw'
export type McpServerName = 'tasks' | 'memory' | 'tools' | 'teamchat'
export type McpTransport = 'stdio' | 'http'

export const MCP_SERVER_NAMES: readonly McpServerName[] = ['tasks', 'memory', 'tools', 'teamchat']

/**
 * The running agent's visibility scope. Carried as query params on the shared
 * Memory server's HTTP attach URL so each run's MCP session is bound to its
 * team/agent (the model can neither widen its visibility nor mis-tag a save).
 * The SAME {teamId, agentId} pair also binds the TeamChat server's room + author
 * identity (`roomTeamId` / `postAuthorAgentId`) — the anti-spoof binding. Tasks/
 * Tools URLs are unaffected.
 */
export interface AttachScope {
  teamId?: string | null
  agentId?: string | null
  tenantId?: string | null
}

export interface AttachConfigInput {
  runtime: McpRuntime
  server: McpServerName
  transport: McpTransport
  /** Absolute path to the built stdio bin (for transport='stdio'). */
  binPath?: string
  /** Optional explicit DB path passed to the bin via CLAWBOO_DB_PATH. */
  dbPath?: string
  /** Base URL of the running clawboo server (for transport='http'). */
  httpBaseUrl?: string
  /** Run scope — appended to the Memory server's HTTP URL only (see AttachScope). */
  scope?: AttachScope
}

/**
 * The HTTP attach URL for a server. The shared Memory server carries the run's
 * scope as query params (`scopeTeamId` / `scopeAgentId` / `scopeTenantId`) so its
 * session binds to the team/agent; tasks/tools stay bare. Exported so a driver
 * that builds URLs inline (Codex) stays in lockstep with `buildAttachConfig`.
 */
export function mcpHttpUrl(
  httpBaseUrl: string,
  server: McpServerName,
  scope?: AttachScope,
): string {
  const base = `${httpBaseUrl.replace(/\/$/, '')}/api/mcp/${server}`
  if (!scope) return base
  const p = new URLSearchParams()
  if (server === 'memory') {
    // Memory: the run's VISIBILITY scope.
    if (scope.teamId) p.set('scopeTeamId', scope.teamId)
    if (scope.agentId) p.set('scopeAgentId', scope.agentId)
    if (scope.tenantId) p.set('scopeTenantId', scope.tenantId)
  } else if (server === 'teamchat') {
    // TeamChat: the run's room + AUTHOR IDENTITY (anti-spoof). The URL is
    // clawboo-written config, so the runtime can't post as a peer it isn't.
    if (scope.teamId) p.set('roomTeamId', scope.teamId)
    if (scope.agentId) p.set('postAuthorAgentId', scope.agentId)
  } else {
    return base // tasks / tools stay bare
  }
  const q = p.toString()
  return q ? `${base}?${q}` : base
}

export interface AttachConfig {
  /** A stable id the runtime registers the server under. */
  id: string
  transport: McpTransport
  /** A copy-pasteable command or config block. */
  snippet: string
  /** Structured form (for programmatic attach, e.g. Claude Code inline mcpServers). */
  structured: Record<string, unknown>
}

function stdioEnv(dbPath?: string): Record<string, string> | undefined {
  return dbPath ? { CLAWBOO_DB_PATH: dbPath } : undefined
}

/**
 * Build the attach config. For stdio, `binPath` is required (the consuming
 * runtime spawns `node <binPath>`). For http, `httpBaseUrl` is required (the
 * runtime connects to `<base>/api/mcp/<server>`).
 */
export function buildAttachConfig(input: AttachConfigInput): AttachConfig {
  const id = `clawboo-${input.server}`

  if (input.transport === 'http') {
    const url = mcpHttpUrl(input.httpBaseUrl ?? 'http://localhost:18790', input.server, input.scope)
    switch (input.runtime) {
      case 'claude-code':
        return {
          id,
          transport: 'http',
          snippet: `claude mcp add --transport http ${id} ${url}`,
          structured: { [id]: { type: 'http', url } },
        }
      case 'codex':
        return {
          id,
          transport: 'http',
          snippet: `# ~/.codex/config.toml\n[mcp_servers.${id}]\nurl = "${url}"`,
          structured: { mcp_servers: { [id]: { url } } },
        }
      case 'openclaw':
        return {
          id,
          transport: 'http',
          // OpenClaw registers MCP servers under the TOP-LEVEL `mcp.servers` key,
          // and a Streamable-HTTP entry needs `transport: "streamable-http"`.
          snippet: `# openclaw.json → mcp.servers\n"${id}": { "url": "${url}", "transport": "streamable-http" }`,
          structured: { url },
        }
    }
  }

  // stdio
  const binPath = input.binPath ?? `<path-to>/dist/bin/${input.server}.js`
  const env = stdioEnv(input.dbPath)
  switch (input.runtime) {
    case 'claude-code': {
      // The bins default to ~/.openclaw/clawboo/clawboo.db; the server uses
      // ~/.clawboo/clawboo.db. Embed CLAWBOO_DB_PATH so a copy-pasted attach
      // reaches the SAME board (Codex already does; claude-code/openclaw must too).
      const envFlag = env ? ` -e CLAWBOO_DB_PATH=${input.dbPath}` : ''
      return {
        id,
        transport: 'stdio',
        snippet: `claude mcp add ${id}${envFlag} -- node ${binPath}`,
        structured: {
          [id]: { type: 'stdio', command: 'node', args: [binPath], ...(env ? { env } : {}) },
        },
      }
    }
    case 'codex': {
      const envToml = env ? `\nenv = { CLAWBOO_DB_PATH = "${input.dbPath}" }` : ''
      return {
        id,
        transport: 'stdio',
        snippet: `# CODEX_HOME/config.toml\n[mcp_servers.${id}]\ncommand = "node"\nargs = ["${binPath}"]${envToml}`,
        structured: {
          mcp_servers: { [id]: { command: 'node', args: [binPath], ...(env ? { env } : {}) } },
        },
      }
    }
    case 'openclaw': {
      // Embed CLAWBOO_DB_PATH so the bin opens the SAME board as the server
      // (the bins' default db path differs from the server's — see above).
      const envJson = env ? `, "env": { "CLAWBOO_DB_PATH": "${input.dbPath}" }` : ''
      return {
        id,
        transport: 'stdio',
        snippet: `# openclaw.json → mcp.servers\n"${id}": { "command": "node", "args": ["${binPath}"]${envJson} }`,
        structured: { command: 'node', args: [binPath], ...(env ? { env } : {}) },
      }
    }
  }
}
