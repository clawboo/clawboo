// Turn a tool discovered from a remote MCP server into a ToolDescriptor.
//
// LIVES HERE, not in the server, because `ToolDescriptor.inputSchema` is a zod
// schema and apps/web has no zod dependency by house rule. The input is
// described structurally rather than imported from @clawboo/mcp, which would
// invert the existing dependency edge.

import { z } from 'zod'

import { isBrokeredReadOnlyMetaTool } from './brokeredApp'
import type { ToolDescriptor, ToolRisk } from './types'

/** The shape an MCP `tools/list` entry arrives in. */
export interface RemoteToolFacts {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Self-declared MCP annotations. Untrusted by default; see below. */
  annotations?: Record<string, unknown>
}

export interface ConnectorDescriptorOptions {
  /** The namespaced name the tool is registered under. */
  name: string
  /**
   * Whether the SERVER's own annotations may be believed.
   *
   * `requiredMode` reads `readOnly`, so a server that self-declares
   * `readOnlyHint: true` on a destructive tool would talk its own required grant
   * mode down from write to read. The MCP spec says plainly that annotations are
   * untrusted hints, so they are honoured only when the trust comes from
   * somewhere else -- a curated catalog entry vouching for the package -- and
   * never from the server's own say-so.
   *
   * The cost of disbelieving them is real: an unannotated tool is treated as a
   * WRITE, so a read-mode grant denies it. That is the safe direction to be
   * wrong in, and it is why an owner grant is minted at admin.
   */
  trustAnnotations: boolean
  /** The connector's declared exfiltration legs, from the CATALOG. */
  trifecta: { readsPrivateData: boolean; ingestsUntrustedContent: boolean; canEgress: boolean }
  /** Proxies the call to the live session. */
  executor: (args: Record<string, unknown>) => Promise<string> | string
}

export function buildConnectorDescriptor(
  tool: RemoteToolFacts,
  opts: ConnectorDescriptorOptions,
): ToolDescriptor {
  // A BROKER'S OWN LOOKUP TOOLS ARE READ-ONLY WHATEVER IT SAYS. Composio sends no
  // annotations, so its catalogue search and schema read inherited the connector's
  // `external` risk and prompted for approval like a send. They execute nothing;
  // treating them as writes made discovery unusable.
  const readOnly =
    isBrokeredReadOnlyMetaTool(opts.name) ||
    (opts.trustAnnotations && tool.annotations?.['readOnlyHint'] === true)
  const destructive = opts.trustAnnotations && tool.annotations?.['destructiveHint'] === true
  // A connector that can send bytes off the machine is `external` at minimum:
  // the risk floor comes from what the CATALOG says the connector can do, never
  // from what the server says about itself.
  const risk: ToolRisk = opts.trifecta.canEgress ? 'external' : 'safe'

  return {
    name: opts.name,
    // Verbatim, including whatever the server chose to put here. It is
    // attacker-authorable text, and every surface that renders it must attribute
    // it to its connector rather than present it as clawboo's own.
    description: tool.description,
    // Permissive locally: the remote server is the authority on its own
    // arguments, and a stricter local guess would reject calls it would accept.
    inputSchema: z.object({}).passthrough(),
    // Advertised verbatim rather than re-derived, which would widen it.
    jsonSchema: tool.inputSchema,
    owner: 'mcp',
    ...(readOnly ? { readOnly: true } : {}),
    ...(destructive ? { destructive: true } : {}),
    trifecta: opts.trifecta,
    risk,
    executor: (args) => opts.executor(args),
  }
}
