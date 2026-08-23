// ─── Tools MCP server ────────────────────────────────────────────────────────
// Lists only AVAILABLE tools (a hidden tool is absent from tools/list, so the
// model can't hallucinate it) and routes every call through the broker
// (inspector chain → DB-mediated approval → execute → compaction → audit).

import {
  createBuiltinRegistry,
  defaultAvailabilityContext,
  evaluateAvailability,
  executeBrokeredCall,
  type AvailabilityContext,
  type BrokerOptions,
  type ClawbooDb,
  type ToolDescriptor,
} from '@clawboo/db'
import type { z } from 'zod'

import { buildServer, textResult, type Server, type ToolDef } from '../shared'

export interface ToolsServerOptions {
  /** Availability context (defaults to env-based). Determines which tools register. */
  availability?: AvailabilityContext
  /** The calling agent (recorded in audit + approvals). */
  agentId?: string
  /**
   * The calling agent's team.
   *
   * Load-bearing for authorization, not just for audit: a null teamId makes
   * every TEAM-scoped grant unfindable, so a call the team was authorized to
   * make is denied `no-grant` with nothing in the record explaining why.
   */
  teamId?: string
  /**
   * Extra descriptors to serve alongside the builtins, and the connector each
   * one belongs to.
   *
   * The registry used to be constructed unconditionally inside this function,
   * which meant a tool discovered from an outbound MCP connection had nowhere
   * to go: it could be registered, but never served. `connectorId` rides
   * alongside because it cannot be recovered from the tool NAME (the identity
   * contains colons, and the agent SDK folds every non-word character to `_`,
   * which is not injective), and without it the grant gate short-circuits to
   * "not governed" -- silent permissiveness, the worst failure available here.
   */
  connectorTools?: readonly { descriptor: ToolDescriptor; connectorId: string }[]
  /** Broker knobs (provenance enforcement, approval TTL/timeout, compaction). */
  broker?: Omit<BrokerOptions, 'registry'>
}

export function createToolsServer(db: ClawbooDb, opts: ToolsServerOptions = {}): Server {
  const registry = createBuiltinRegistry()
  const availability = opts.availability ?? defaultAvailabilityContext()

  // Connector tools join the SAME registry the broker resolves against, so a
  // call cannot reach an executor the broker does not know about.
  // `registerOrThrow` rather than `register`: the silent last-wins default is
  // how a connector tool named `read_file` would replace a builtin, inheriting
  // its risk classification and therefore its approval behaviour.
  const connectorOf = new Map<string, string>()
  for (const entry of opts.connectorTools ?? []) {
    try {
      registry.registerOrThrow(entry.descriptor)
      connectorOf.set(entry.descriptor.name, entry.connectorId)
    } catch {
      // DROP the offending tool, never the server. This factory runs on every
      // `initialize`, so a throw here does not fail one tool or even one
      // connector: it fails construction, which loses every builtin for every
      // agent until someone disconnects the connector that caused it. No remote
      // server gets to decide whether the local tools server can be built.
      //
      // The caller is expected to have de-duplicated already; this is the
      // backstop for a collision it did not anticipate, including one against a
      // builtin name.
    }
  }

  const tools: ToolDef[] = registry
    .list()
    .filter((descriptor) => evaluateAvailability(descriptor, availability).visible)
    .map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema as z.ZodObject<z.ZodRawShape>,
      ...(descriptor.jsonSchema ? { jsonSchema: descriptor.jsonSchema } : {}),
      handler: async (args: Record<string, unknown>) => {
        const connectorId = connectorOf.get(descriptor.name)
        const result = await executeBrokeredCall(
          db,
          { name: descriptor.name, args },
          {
            agentId: opts.agentId,
            availability,
            // Both are spread CONDITIONALLY so a builtin-only construction
            // produces exactly the context it produced before this change.
            ...(opts.teamId ? { teamId: opts.teamId } : {}),
            ...(connectorId ? { connectorId } : {}),
          },
          { registry, ...opts.broker },
        )
        // Carry a typed denial (availability/provenance/inspector/approval) on
        // `_meta` so an in-process caller can surface a policy-denied signal.
        return textResult(result.output, result.isError, result.denied)
      },
    }))

  return buildServer('clawboo-tools', tools)
}
