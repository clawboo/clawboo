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
