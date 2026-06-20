// ─── In-process Streamable-HTTP mount ────────────────────────────────────────
// Exposes a server factory over MCP's Streamable HTTP transport so the API
// server supervises it (and HTTP-capable clients can attach at /api/mcp/<name>).
// Stateful sessions keyed by the `mcp-session-id` header. Typed against node:http
// so this package needn't depend on express (Express req/res are assignable).

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

import type { Server } from './shared'

export interface McpHttpHandlers {
  /** POST — the parsed JSON-RPC body must be passed in (Express parses it upstream). */
  handlePost(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>
  /** GET (SSE stream) + DELETE (session teardown) on the same path. */
  handleSessionRequest(req: IncomingMessage, res: ServerResponse): Promise<void>
}

function jsonError(res: ServerResponse, code: number, message: string): void {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

/**
 * Build POST/GET/DELETE handlers for one server factory. A fresh server +
 * transport is created per MCP session (on the initialize request) and reused
 * for that session's subsequent requests. The session's initialize request is
 * handed to the factory so a server can bind per-session state from the URL —
 * e.g. the Memory server reads its scope query params (back-compatible: an
 * existing `() => Server` factory simply ignores the arg).
 */
export function createStreamableHttpHandlers(
  createServer: (req?: IncomingMessage) => Server,
): McpHttpHandlers {
  const transports = new Map<string, StreamableHTTPServerTransport>()

  async function handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const sid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sid) ? sid[0] : sid

    const existing = sessionId ? transports.get(sessionId) : undefined
    if (existing) {
      await existing.handleRequest(req, res, body)
      return
    }
    if (sessionId || !isInitializeRequest(body)) {
      jsonError(res, 400, 'No valid session; send an initialize request first.')
      return
    }

    const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, created)
      },
    })
    created.onclose = () => {
      const id = created.sessionId
      if (id) transports.delete(id)
    }
    await createServer(req).connect(created)
    await created.handleRequest(req, res, body)
  }

  async function handleSessionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sid) ? sid[0] : sid
    const transport = sessionId ? transports.get(sessionId) : undefined
    if (!transport) {
      jsonError(res, 400, 'Invalid or missing MCP session id.')
      return
    }
    await transport.handleRequest(req, res)
  }

  return { handlePost, handleSessionRequest }
}
