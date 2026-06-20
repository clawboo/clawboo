// In-memory MCP client — the in-process consumption path for runtimes hosted
// INSIDE the clawboo server (the native runtime). Same linked-transport shape as
// `probeServer`, but long-lived: the caller holds the client for a whole
// conversation and closes it at the end. Keeps the SDK Client/InMemoryTransport
// encapsulated in this package (the house convention — consumers never import
// the MCP SDK directly).

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { Server } from './shared'

export interface McpToolInfo {
  name: string
  description?: string
  /** JSON Schema for the tool's arguments (as served by tools/list). */
  inputSchema?: Record<string, unknown>
}

export interface McpCallOutcome {
  output: string
  isError: boolean
  /** Set (to the reason) when the call was DENIED by the tools broker — read from
   *  the result's `_meta.denied`. Lets an in-process caller surface a policy-denied
   *  signal without parsing the text. */
  denied?: string
}

/** The minimal structural client surface an in-process consumer needs. */
export interface InMemoryMcpClient {
  listTools(): Promise<McpToolInfo[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallOutcome>
  close(): Promise<void>
}

/**
 * Connect a long-lived Client to `server` over a linked in-memory transport
 * pair. `close()` tears down both ends (idempotent, never throws).
 */
export async function connectInMemoryClient(
  server: Server,
  name = 'clawboo-inproc',
): Promise<InMemoryMcpClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name, version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    async listTools(): Promise<McpToolInfo[]> {
      const res = await client.listTools()
      return res.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
      }))
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
      const res = await client.callTool({ name, arguments: args })
      const content = Array.isArray(res.content) ? res.content : []
      const output = content
        .map((c) =>
          c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '',
        )
        .join('')
      const meta = res._meta as { denied?: unknown } | undefined
      const denied = typeof meta?.denied === 'string' ? meta.denied : undefined
      return { output, isError: res.isError === true, ...(denied ? { denied } : {}) }
    },
    async close(): Promise<void> {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    },
  }
}
