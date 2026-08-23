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
  ToolRegistry,
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
  connectorTools?:
    | readonly { descriptor: ToolDescriptor; connectorId: string }[]
    | (() => readonly { descriptor: ToolDescriptor; connectorId: string }[])
  /**
   * Subscribe to connector changes, so the server can tell clients to re-list.
   *
   * Without it the `listChanged` capability is a declaration with nothing behind
   * it: a connector added mid-session stays invisible until the client happens
   * to reconnect, and a disconnected one keeps being offered until the model
   * gives up calling it.
   */
  onConnectorsChanged?: (notify: () => void) => () => void
  /** Broker knobs (provenance enforcement, approval TTL/timeout, compaction). */
  broker?: Omit<BrokerOptions, 'registry'>
}

export function createToolsServer(db: ClawbooDb, opts: ToolsServerOptions = {}): Server {
  const availability = opts.availability ?? defaultAvailabilityContext()

  /**
   * Compose the registry from the builtins plus whatever connectors are live
   * RIGHT NOW.
   *
   * Recomputed per list and per call rather than captured once, because a
   * connector can arrive or leave inside a session and both the advertised list
   * and the dispatcher have to agree about that.
   */
  const compose = (): { registry: ToolRegistry; connectorOf: Map<string, string> } => {
    const registry = createBuiltinRegistry()
    const connectorOf = new Map<string, string>()
    const entries =
      typeof opts.connectorTools === 'function'
        ? opts.connectorTools()
        : (opts.connectorTools ?? [])
    for (const entry of entries) {
      try {
        // `registerOrThrow` rather than `register`: the silent last-wins default
        // is how a connector tool named `read_file` would replace a builtin,
        // inheriting its risk classification and therefore its approval
        // behaviour.
        registry.registerOrThrow(entry.descriptor)
        connectorOf.set(entry.descriptor.name, entry.connectorId)
      } catch {
        // DROP the offending tool, never the server. No remote server gets to
        // decide whether the local tools server can be built.
      }
    }
    return { registry, connectorOf }
  }

  const toolsNow = (): ToolDef[] => {
    const { registry, connectorOf } = compose()
    return registry
      .list()
      .filter((descriptor) => evaluateAvailability(descriptor, availability).visible)
      .map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema as z.ZodObject<z.ZodRawShape>,
        ...(descriptor.jsonSchema ? { jsonSchema: descriptor.jsonSchema } : {}),
        handler: async (args: Record<string, unknown>) => {
          // Re-composed at CALL time: the registry the broker resolves against
          // must contain the tool being called, and a session that started
          // before this connector existed would otherwise hold a stale one.
          const live = compose()
          const connectorId =
            live.connectorOf.get(descriptor.name) ?? connectorOf.get(descriptor.name)
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
            { registry: live.registry, ...opts.broker },
          )
          // Carry a typed denial (availability/provenance/inspector/approval) on
          // `_meta` so an in-process caller can surface a policy-denied signal.
          return textResult(result.output, result.isError, result.denied)
        },
      }))
  }

  const server = buildServer('clawboo-tools', toolsNow)

  // Turn the declared `listChanged` capability into a real one. Best-effort: a
  // notification that fails must never take down the session it was announcing
  // a change to.
  const unsubscribe = opts.onConnectorsChanged?.(() => {
    void server.sendToolListChanged?.().catch(() => {})
  })
  if (unsubscribe) {
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      unsubscribe()
    }
    const previousClose = server.onclose
    server.onclose = () => {
      release()
      previousClose?.()
    }
    // `onclose` is not guaranteed: a transport that errors, or a session the
    // client abandons without closing, leaves the listener in a module-level Set
    // forever. Every abandoned session would then keep a whole server object
    // alive and take a notification on every connector change.
    const previousError = server.onerror
    server.onerror = (err: Error) => {
      release()
      previousError?.(err)
    }
  }

  return server
}
