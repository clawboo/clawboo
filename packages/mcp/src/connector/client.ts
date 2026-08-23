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
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** Generous: a cold `npx` install happens inside this window, not before it. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000
/** Per tools/list page. A server that cannot list in this long is not usable. */
export const DEFAULT_LIST_TIMEOUT_MS = 20_000
/** Per tools/call. Deliberately shorter than the approval wait it may follow. */
export const DEFAULT_CALL_TIMEOUT_MS = 45_000

/** Stop paging here. A server advertising more tools than this is misbehaving,
 *  and an unbounded cursor loop is a hang with extra steps. */
const MAX_LIST_PAGES = 20
/** Total wall clock for discovery, across every page. The per-page timeout alone
 *  lets 20 slow pages hold a connect request for the sum of all of them. */
const DEFAULT_DISCOVERY_BUDGET_MS = 90_000
/** Enough of a failing server's last words to diagnose it, bounded so a chatty
 *  one cannot grow this without limit. */
const STDERR_TAIL_BYTES = 4_000
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
  /**
   * Whether the last `listTools` hit a cap and returned a PARTIAL inventory.
   *
   * Load-bearing rather than informational: a digest computed over a truncated
   * list does not describe the server, so it would read as drift against the
   * real one from then on.
   */
  wasTruncated(): boolean
  callTool(name: string, args: Record<string, unknown>): Promise<ConnectorCallResult>
  /**
   * Fires when the child exits, for ANY reason, including one we did not cause.
   *
   * Without it a crashed connector stays "live" in every consumer: its tools go
   * on being served, the graph goes on reporting it ready, and a pid the OS may
   * have recycled stays in the shutdown registry.
   */
  onClose(handler: () => void): void
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
  /** Total wall clock for discovery across every page. */
  discoveryBudgetMs?: number
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

/**
 * A handshake that failed AFTER a process was spawned.
 *
 * Carries the pid because `transport.close()` signals only the direct child, and
 * a catalog launch is an `npx` wrapper: without the pid the caller cannot reap
 * the tree, and a failed connect silently leaks the real server.
 */
export class ConnectorHandshakeError extends Error {
  constructor(
    message: string,
    public readonly pid: number | null,
  ) {
    super(message)
    this.name = 'ConnectorHandshakeError'
  }
}

export interface HttpConnectorSpec {
  url: string
  /** Sent as `Authorization: Bearer`. Omit for a server that needs no auth. */
  accessToken?: string
  handshakeTimeoutMs?: number
  listTimeoutMs?: number
  callTimeoutMs?: number
  discoveryBudgetMs?: number
}

/**
 * Connect to a REMOTE MCP server over streamable HTTP.
 *
 * Shares every timeout, paging rule and result-flattening decision with the
 * stdio path by construction: the session object below is built by the same
 * factory, so a fix to one is a fix to both rather than a thing someone has to
 * remember to port.
 *
 * There is no child process here, so `pid` is null and nothing needs reaping.
 * The corresponding hazard is different: a token, which lives in the vault and
 * never in this module beyond the request header it is written into.
 */
export async function connectHttpConnector(spec: HttpConnectorSpec): Promise<ConnectorSession> {
  const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
    ...(spec.accessToken
      ? { requestInit: { headers: { Authorization: `Bearer ${spec.accessToken}` } } }
      : {}),
  })
  return finishConnect(transport, spec, {
    // No child process, so nothing to reap and nothing to report.
    pid: () => null,
    // A remote server's failure explanation arrives in the HTTP response the SDK
    // already surfaces, so there is no side channel to drain here.
    diagnostic: () => '',
  })
}

/** Connect to a stdio MCP server, completing the handshake before returning. */
export async function connectStdioConnector(spec: StdioConnectorSpec): Promise<ConnectorSession> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: spec.env,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    // Never 'inherit': a connector writing to our stderr would interleave with
    // clawboo's own structured logs and could forge log lines. But 'pipe' alone
    // is a hang: the stream is a PassThrough, and a chatty connector BLOCKS on
    // its own writes once the buffer fills. It is drained below into a bounded
    // tail, which also gives a failed handshake something to say.
    stderr: 'pipe',
  })

  // Drained continuously and kept to a bounded tail: unread it would
  // backpressure the child, and unbounded it would be a memory leak driven by a
  // remote server.
  let stderrTail = ''
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
  })
  transport.stderr?.on('error', () => {
    /* a broken stderr pipe must never take down the connection */
  })

  return finishConnect(transport, spec, {
    pid: () => transport.pid,
    diagnostic: () => stderrTail.trim(),
  })
}

/** What a transport can tell us beyond the protocol, so the shared factory does
 *  not have to know which kind it is holding. */
interface TransportFacts {
  /** The child's pid for a stdio transport; null for a remote one. */
  pid: () => number | null
  /** The server's own last words on a failed handshake, when there are any. */
  diagnostic: () => string
}

/**
 * Everything both transports share: handshake, paging, call, close.
 *
 * ONE implementation rather than two similar ones. Every decision in here was
 * made because a real server misbehaved -- the paging, the throw-to-isError
 * mapping, the content flattening, the truncation flag -- and a second copy is a
 * second place for those to silently diverge.
 */
async function finishConnect(
  transport: { close(): Promise<void>; onclose?: () => void },
  spec: {
    handshakeTimeoutMs?: number
    listTimeoutMs?: number
    callTimeoutMs?: number
    discoveryBudgetMs?: number
  },
  facts: TransportFacts,
): Promise<ConnectorSession> {
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
    await client.connect(transport as Parameters<Client['connect']>[0], {
      timeout: spec.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    })
  } catch (err) {
    // The transport may already hold a spawned child; closing is what stops a
    // failed connect from leaking a process. `close()` reaps only the direct
    // child, so the caller is also handed the pid to kill the tree.
    const leakedPid = facts.pid()
    await transport.close().catch(() => {})
    const tail = facts.diagnostic()
    throw new ConnectorHandshakeError(
      // The child's own last words, when it had any. A bare "timeout" for a
      // server that printed a clear error is a diagnostic thrown away.
      tail
        ? `connector handshake failed: ${errorText(err)} — ${tail}`
        : `connector handshake failed: ${errorText(err)}`,
      leakedPid,
    )
  }

  let lastListTruncated = false
  const closeHandlers: (() => void)[] = []
  let closed = false
  const fireClosed = (): void => {
    // Once only: the SDK can surface both a transport close and a client close
    // for the same exit, and a consumer that tears down twice would race itself.
    if (closed) return
    closed = true
    for (const h of closeHandlers) {
      try {
        h()
      } catch {
        /* one bad handler must not stop the others */
      }
    }
  }
  transport.onclose = fireClosed

  return {
    get pid() {
      return facts.pid()
    },

    onClose(handler) {
      if (closed) handler()
      else closeHandlers.push(handler)
    },

    async listTools(): Promise<DiscoveredTool[]> {
      const out: DiscoveredTool[] = []
      const seen = new Set<string>()
      let truncated = false
      const deadline = Date.now() + (spec.discoveryBudgetMs ?? DEFAULT_DISCOVERY_BUDGET_MS)
      let cursor: string | undefined
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        // The per-page timeout is not a total: twenty slow-but-legal pages would
        // hold a connect request for their sum.
        if (Date.now() > deadline) break
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
          // Stop the PAGE, not the function: falling out of the loop keeps the
          // truncation visible to the caller through `truncated`, where an early
          // return would have handed back a partial list indistinguishable from
          // a complete one -- and the tools digest computed over it would read
          // as drift against the real inventory forever after.
          if (out.length >= MAX_CONNECTOR_TOOLS) {
            truncated = true
            break
          }
        }
        if (truncated) break
        cursor = res.nextCursor
        // A server that repeats its cursor would otherwise re-serve the same page
        // until MAX_LIST_PAGES, manufacturing duplicate tools from a plain bug.
        if (!cursor || seen.has(cursor)) break
        seen.add(cursor)
      }
      lastListTruncated = truncated || out.length >= MAX_CONNECTOR_TOOLS
      return out
    },

    wasTruncated() {
      return lastListTruncated
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
