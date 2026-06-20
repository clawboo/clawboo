// ─── In-memory test harness ──────────────────────────────────────────────────
// Connect a Client to a server over a linked in-memory transport pair — the
// CI-enforceable form of "heterogeneous consumability" (no subprocess, no
// network). Used by the contract tests; not part of the public API surface.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import type { Server } from './shared'

export async function connectInMemory(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'clawboo-contract-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** Names of the tools a connected client currently sees (availability-filtered). */
export async function listToolNames(client: Client): Promise<string[]> {
  const res = await client.listTools()
  return res.tools.map((t) => t.name)
}

/** Call a tool and return its first text content block. */
export async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = await client.callTool({ name, arguments: args })
  const content = (res.content ?? []) as { type: string; text?: string }[]
  const first = content.find((c) => c.type === 'text')
  return { text: first?.text ?? '', isError: Boolean(res.isError) }
}
