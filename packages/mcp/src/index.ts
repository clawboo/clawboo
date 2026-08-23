// ─── @clawboo/mcp — Tasks / Memory / Tools / TeamChat MCP servers ────────────
// Thin protocol adapters over the @clawboo/db service cores, exposed over both
// stdio (a consuming runtime spawns a bin) and in-process Streamable HTTP.

export { createTasksServer } from './tasks/server'
export { createMemoryServer } from './memory/server'
export { createToolsServer, type ToolsServerOptions } from './tools/server'
export {
  createTeamChatServer,
  type TeamChatServerOptions,
  type TeamChatBoundIdentity,
} from './teamchat/server'
export { signAttachScope, verifyAttachScope, type SignableScope } from './attachAuth'
export { formatPeerPost, type PeerPostLike } from './teamchat/format'

export { runStdioServer } from './stdio'
export { createStreamableHttpHandlers, type McpHttpHandlers } from './http'
export { probeServer } from './probe'
export {
  connectInMemoryClient,
  type InMemoryMcpClient,
  type McpCallOutcome,
  type McpToolInfo,
} from './inMemoryClient'

export {
  buildAttachConfig,
  mcpHttpUrl,
  MCP_SERVER_NAMES,
  type AttachConfig,
  type AttachConfigInput,
  type AttachScope,
  type McpRuntime,
  type McpServerName,
  type McpTransport,
} from './config'

export { MCP_SERVER_VERSION } from './shared'

// ── Outbound MCP client — clawboo connecting OUT to somebody else's server ──
// Lives here because @modelcontextprotocol/sdk is a dependency of this package
// alone; pnpm's strict layout puts it out of reach of apps/web.
export {
  connectHttpConnector,
  connectStdioConnector,
  ConnectorHandshakeError,
  flattenContent,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_LIST_TIMEOUT_MS,
  MAX_CONNECTOR_TOOLS,
  type ConnectorCallResult,
  type ConnectorSession,
  type DiscoveredTool,
  type HttpConnectorSpec,
  type StdioConnectorSpec,
} from './connector/client'
export {
  connectorChildEnv,
  CONNECTOR_ENV_ALLOWLIST,
  type ConnectorEnvOptions,
} from './connector/env'

// ── OAuth 2.1 for remote MCP servers ──
// Discovery-first (RFC 9728 -> RFC 8414), PKCE S256 only, and dynamic client
// registration because clawboo has no registered app and a desktop tool cannot
// keep a secret.
export {
  buildAuthorizeUrl,
  createPkce,
  discoverAuthServer,
  discoverResourceMetadata,
  exchangeCode,
  refreshToken,
  registerClient,
  resourceMetadataUrl,
  type AuthServerMetadata,
  type Pkce,
  type ProtectedResourceMetadata,
  type RegisteredClient,
  type TokenSet,
} from './connector/oauth'
