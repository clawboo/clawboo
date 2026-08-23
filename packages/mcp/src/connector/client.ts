// The OUTBOUND MCP client: clawboo connecting to somebody else's server.
//
// Everything before this file made clawboo an MCP SERVER. This is the first
// place it is a client, and the failure modes are the opposite ones: a server we
// do not control can hang, lie about its tool list, return content shapes we do
// not handle, or throw where we expected a value.
//
// LIVES IN packages/mcp BECAUSE THE SDK DOES. `@modelcontextprotocol/sdk` is a
// dependency of this package alone, and pnpm's strict layout means a client
// written under apps/web could not resolve it.
//
// THREE SEPARATE BUDGETS, and they are separate for a reason. The SDK applies
// one 60s default to every request, and `StdioClientTransport.start()` resolves
// on the child's `spawn` event rather than on a handshake — so a process that
// launches and never speaks MCP wedges a request for a full minute with nothing
// to show for it. Worse, a cold `npx -y pkg@ver` performs a real network install
// AFTER spawn, so the install lands inside the HANDSHAKE window, not the spawn
// one. The handshake budget is therefore the generous one.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** Generous: a cold `npx` install happens inside this window, not before it. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000
/** Per tools/list page. A server that cannot list in this long is not usable. */
export const DEFAULT_LIST_TIMEOUT_MS = 20_000
/** Per tools/call. Deliberately shorter than the approval wait it may follow. */
export const DEFAULT_CALL_TIMEOUT_MS = 45_000

/** Stop paging here. A server advertising more tools than this is misbehaving,
 *  and an unbounded cursor loop is a hang with extra steps. */
const MAX_LIST_PAGES = 20
/** Hard cap on tools accepted from one server, for the same reason. */
export const MAX_CONNECTOR_TOOLS = 500

export interface DiscoveredTool {
  name: string
  description: string
  /** The server's own JSON Schema, carried verbatim. */
  inputSchema: Record<string, unknown>
  /**
   * Self-declared MCP annotations.
   *
   * HINTS, NOT AUTHORIZATION. The SDK's own types warn against trusting these
   * from an untrusted server, and a connector that sets `readOnlyHint: true` on
   * a destructive tool would otherwise talk its own required grant mode down
   * from write to read. They may feed a risk classifier; they must never be the
   * thing that decides what a grant needs to cover.
   */
  annotations?: Record<string, unknown>
}

export interface ConnectorSession {
  /**
   * The direct child's pid, or null.
   *
   * Exposed because `close()` is NOT sufficient to reap the process tree: the
   * transport kills only the process it spawned, and a catalog launch is
   * `npx -y <pkg>` — a wrapper whose real server is a grandchild. A supervisor
   * must register this pid and kill the tree.
   */
  readonly pid: number | null
  listTools(): Promise<DiscoveredTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<ConnectorCallResult>
  close(): Promise<void>
}

export interface ConnectorCallResult {
  text: string
  isError: boolean
}

export interface StdioConnectorSpec {
  command: string
  args: string[]
  /** The child's environment. Pass `connectorChildEnv()`; never `process.env`. */
  env: Record<string, string>
  cwd?: string
  handshakeTimeoutMs?: number
  listTimeoutMs?: number
  callTimeoutMs?: number
}

/**
 * Flatten a CallToolResult's content into one string.
 *
 * Non-text blocks are DESCRIBED, never dropped. The previous in-memory adapter
 * mapped anything without a `text` field to `''`, so a screenshot tool returned
 * an empty string and looked like a success with no output — the model then
 * retried, or worse, proceeded as if the call had produced nothing of interest.
 * A visible placeholder is a far better failure.
 */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    switch (b['type']) {
      case 'text':
        parts.push(String(b['text'] ?? ''))
        break
      case 'image':
        parts.push(`[image: ${String(b['mimeType'] ?? 'unknown')}, not rendered]`)
        break
      case 'audio':
        parts.push(`[audio: ${String(b['mimeType'] ?? 'unknown')}, not rendered]`)
        break
      case 'resource_link':
        parts.push(`[resource: ${String(b['uri'] ?? '')}]`)
        break
      case 'resource': {
        const res = b['resource']
        const inner = res && typeof res === 'object' ? (res as Record<string, unknown>) : {}
        parts.push(
          typeof inner['text'] === 'string'
            ? String(inner['text'])
            : `[embedded resource: ${String(inner['uri'] ?? 'unknown')}]`,
        )
        break
      }
      default:
        // An unrecognised block type is still evidence the call produced
        // something. Saying so beats silently shortening the output.
        parts.push(`[unsupported content: ${String(b['type'] ?? 'unknown')}]`)
    }
  }
  return parts.join('\n')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Connect to a stdio MCP server, completing the handshake before returning. */
export async function connectStdioConnector(spec: StdioConnectorSpec): Promise<ConnectorSession> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    // Never 'inherit': a connector writing to our stderr would interleave with
    // clawboo's own structured logs and could forge log lines.
    stderr: 'pipe',
  })

  const client = new Client(
    { name: 'clawboo', version: '0.0.0' },
    // We advertise no client capabilities: clawboo does not implement sampling
    // or roots for connectors, and claiming otherwise invites requests we would
    // have to refuse mid-call.
    { capabilities: {} },
  )

  const listTimeout = spec.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS
  const callTimeout = spec.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS

  try {
    await client.connect(transport, {
      timeout: spec.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    })
  } catch (err) {
    // The transport may already hold a spawned child; closing is what stops a
    // failed connect from leaking a process.
    await transport.close().catch(() => {})
    throw new Error(`connector handshake failed: ${errorText(err)}`)
  }

  return {
    get pid() {
      return transport.pid
    },

    async listTools(): Promise<DiscoveredTool[]> {
      const out: DiscoveredTool[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        // Paged on purpose: a single listTools() call returns only the first
        // page, and an incomplete inventory produces a WRONG tools digest,
        // which then reads as drift on the very next comparison.
        const res = await client.listTools(cursor ? { cursor } : {}, { timeout: listTimeout })
        for (const t of res.tools ?? []) {
          out.push({
            name: t.name,
            description: t.description ?? '',
            inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
            ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}),
          })
          if (out.length >= MAX_CONNECTOR_TOOLS) return out
        }
        cursor = res.nextCursor
        if (!cursor) break
      }
      return out
    },

    async callTool(name, args): Promise<ConnectorCallResult> {
      try {
        const res = await client.callTool({ name, arguments: args }, undefined, {
          timeout: callTimeout,
        })
        return {
          text: flattenContent((res as { content?: unknown }).content),
          isError: (res as { isError?: boolean }).isError === true,
        }
      } catch (err) {
        // callTool THROWS rather than returning isError for a timeout, a
        // transport failure, or an output-schema validation failure. Letting
        // that propagate would surface as an unhandled rejection inside the
        // broker; a hostile server should not be able to do that.
        return { text: `connector call failed: ${errorText(err)}`, isError: true }
      }
    },

    async close(): Promise<void> {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    },
  }
}
