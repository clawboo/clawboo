// Liveness probe — an in-memory MCP round-trip used by the server's liveness
// supervisor. Keeps the SDK Client/InMemoryTransport encapsulated in this package
// (the same shape as the contract test's `connectInMemory`), so consumers probe a
// server without importing the SDK directly.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { Server } from './shared'

/** Connect a Client to `server` over a linked in-memory transport pair and list
 *  its tools. Resolves to the tool count; throws on any failure (connect / list).
 *  Closes both ends in a finally so a probe never leaks a transport. */
export async function probeServer(server: Server): Promise<number> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'clawboo-mcp-probe', version: '0.0.0' })
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return (await client.listTools()).tools.length
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}
