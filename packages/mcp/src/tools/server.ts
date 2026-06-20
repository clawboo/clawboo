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
} from '@clawboo/db'
import type { z } from 'zod'

import { buildServer, textResult, type Server, type ToolDef } from '../shared'

export interface ToolsServerOptions {
  /** Availability context (defaults to env-based). Determines which tools register. */
  availability?: AvailabilityContext
  /** The calling agent (recorded in audit + approvals). */
  agentId?: string
  /** Broker knobs (provenance enforcement, approval TTL/timeout, compaction). */
  broker?: Omit<BrokerOptions, 'registry'>
}

export function createToolsServer(db: ClawbooDb, opts: ToolsServerOptions = {}): Server {
  const registry = createBuiltinRegistry()
  const availability = opts.availability ?? defaultAvailabilityContext()

  const tools: ToolDef[] = registry
    .list()
    .filter((descriptor) => evaluateAvailability(descriptor, availability).visible)
    .map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema as z.ZodObject<z.ZodRawShape>,
      handler: async (args: Record<string, unknown>) => {
        const result = await executeBrokeredCall(
          db,
          { name: descriptor.name, args },
          { agentId: opts.agentId, availability },
          { registry, ...opts.broker },
        )
        // Carry a typed denial (availability/provenance/inspector/approval) on
        // `_meta` so an in-process caller can surface a policy-denied signal.
        return textResult(result.output, result.isError, result.denied)
      },
    }))

  return buildServer('clawboo-tools', tools)
}
