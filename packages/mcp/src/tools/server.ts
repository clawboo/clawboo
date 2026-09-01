// ─── Tools MCP server ────────────────────────────────────────────────────────
// Lists only AVAILABLE tools (a hidden tool is absent from tools/list, so the
// model can't hallucinate it) and routes every call through the broker
// (inspector chain → DB-mediated approval → execute → compaction → audit).

import {
  createBuiltinRegistry,
  defaultAvailabilityContext,
  evaluateAvailability,
  brokeredMetaToolKind,
  executeBrokeredCall,
  readToolResult,
  grantedBrokeredToolkits,
  isToolVisibleToAgent,
  type AvailabilityContext,
  ToolRegistry,
  type BrokerOptions,
  type ClawbooDb,
  type ToolDescriptor,
} from '@clawboo/db'
import { z } from 'zod'

import { DEFAULT_TOOL_RESULT_BUDGET_BYTES, makeResultCeiling } from '../ceiling'
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
  /** Recorded on a stored tool result, so a spill is attributable. */
  tenantId?: string
  /**
   * Bytes one tool result may occupy in a model's context. Defaults to
   * `DEFAULT_TOOL_RESULT_BUDGET_BYTES`; a host that knows its model's window can
   * pass something better.
   */
  toolResultBudgetBytes?: number
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
  /**
   * Broker apps the install has authorised, for a caller with NO agent identity.
   *
   * An OpenClaw session is unbound by construction (one process-wide config
   * serves every agent), so no agent-scoped grant is findable and the granted
   * list is always empty. Naming nothing left the model reporting that it had
   * Composio but no email service, which is the bug this exists to stop. These
   * are reachable subject to an approval, so they are named as such.
   */
  brokeredConnected?: readonly string[]
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

  /**
   * The description the model reads, with the broker's apps named.
   *
   * A BROKER'S TOOLS ARE NAMED FOR THE BROKER. An agent granted Gmail sees seven
   * tools called `COMPOSIO_*` and no mention of email anywhere, so asked to check
   * its inbox it answered that it had Composio connected but no email service.
   * That was an accurate reading of its own tool list. Naming the granted apps
   * here is the one place the model is guaranteed to look.
   */
  const describeFor = (
    descriptor: ToolDescriptor,
    connectorId: string | null,
    /** Resolved ONCE per list, not per tool: see `toolsNow`. */
    grantedApps: readonly string[],
  ): string => {
    // CLAWBOO ADDS, IT NEVER EDITS. A description is a vendor's contract with the
    // model, and it is the only retrieval signal the model has for choosing a
    // tool. Shortening one to save prompt was tried and reverted: a byte cap over
    // the registry on this install would have cut 12,643 bytes across five tools,
    // and on `sequentialthinking` it kept the preamble while deleting seven of the
    // tool's eight parameter definitions. Vendors front-load prose and back-load
    // the contract, so any size-driven cut lands on the part that matters, and it
    // lands silently. Everything below only APPENDS clawboo's own authoritative
    // context to what the server said.
    const base = descriptor.description

    const known = opts.broker?.brokeredToolkits
    if (!connectorId || !known || known.length === 0) return base
    if (brokeredMetaToolKind(descriptor.name) !== 'app-facing') return base
    const apps = grantedApps
    if (apps.length > 0) {
      // Upper-cased because that is how the broker prefixes its own tool slugs,
      // so an agent told GMAIL can go straight to GMAIL_FETCH_EMAILS.
      const named = apps.map((a) => a.toUpperCase()).join(', ')
      return `${base}\n\nApps this agent may use: ${named}.`
    }
    // NO IDENTITY, so no grant could be found. Say what is reachable and that it
    // will be asked about, rather than leaving the model to conclude it has no
    // email service while holding a working email connector.
    const available = opts.brokeredConnected ?? []
    if (!opts.agentId && available.length > 0) {
      const named = available.map((a) => a.toUpperCase()).join(', ')
      return `${base}\n\nApps reachable here, each subject to the operator approving the first call: ${named}.`
    }
    return base
  }

  // Reads back a result the ceiling stored. Marked `structuredResult` so the
  // ceiling never trims its own recovery path: a page that came back trimmed
  // would need a second handle to recover, and so on without end.
  const readToolResultTool: ToolDef = {
    name: 'read_tool_result',
    structuredResult: true,
    description:
      'Read a tool result that was too large to return in full. Pass the handle from the notice in the truncated result. Page through it with offset and limit (both in bytes), or pass search to get only the matching lines with their byte offsets so you can seek straight to one.',
    inputSchema: z.object({
      handle: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
      search: z.string().optional(),
    }),
    handler: (args) => {
      const handle = String(args['handle'] ?? '')
      const limit = Math.min(
        Number(args['limit'] ?? DEFAULT_TOOL_RESULT_BUDGET_BYTES),
        opts.toolResultBudgetBytes ?? DEFAULT_TOOL_RESULT_BUDGET_BYTES,
      )
      const page = readToolResult(db, handle, {
        limit,
        ...(args['offset'] != null ? { offset: Number(args['offset']) } : {}),
        ...(args['search'] != null ? { search: String(args['search']) } : {}),
      })
      if (!page) {
        // An unknown handle is NOT an empty result. Saying so is what stops the
        // model reporting "there was nothing there" about bytes that expired.
        return textResult(
          `No stored result for handle ${JSON.stringify(handle)}. It may have expired. Re-run the original tool call with narrower arguments to get the data again.`,
          true,
        )
      }
      const partialStore =
        page.storedBytes < page.totalBytes
          ? ` The stored copy itself is partial: ${page.storedBytes} of ${page.totalBytes} bytes were kept.`
          : ''
      const next = page.more
        ? ` Read the next page with {"handle":"${handle}","offset":${page.nextOffset},"limit":${limit}}.`
        : ' This is the end of the result.'
      return textResult(`${page.text}\n\n[${page.totalBytes} bytes total.${partialStore}${next}]`)
    },
  }

  const toolsNow = (): ToolDef[] => {
    const { registry, connectorOf } = compose()

    // ONCE PER LIST, NOT ONCE PER TOOL. The granted-app lookup asks the grant
    // table for every toolkit the broker knows, and the answer is identical for
    // every tool on the same connector. Called from `describeFor` it ran that
    // sweep for each app-facing meta-tool: forty-one queries times five tools on
    // every `tools/list`, and a list happens on every turn.
    const grantedByConnector = new Map<string, readonly string[]>()
    const grantedFor = (connectorId: string | null): readonly string[] => {
      const known = opts.broker?.brokeredToolkits
      if (!connectorId || !known || known.length === 0) return []
      const hit = grantedByConnector.get(connectorId)
      if (hit) return hit
      const apps = grantedBrokeredToolkits(
        db,
        connectorId,
        { agentId: opts.agentId ?? null, teamId: opts.teamId ?? null },
        known,
      )
      grantedByConnector.set(connectorId, apps)
      return apps
    }
    return (
      registry
        .list()
        .filter((descriptor) => evaluateAvailability(descriptor, availability).visible)
        // GRANTS DECIDE WHAT IS EVEN OFFERED, not just what succeeds. A connector
        // tool this agent has not been given was listed with its full schema and
        // then refused on use: the model spent context reading a capability it
        // could never have, and its failure said `grant:no-grant` rather than
        // anything it could act on. `connectorOf` already holds the one fact the
        // gate cannot recover from a tool name, so the same question the gate asks
        // is answerable right here, without charging a rate window or writing an
        // audit row for a call nobody made.
        .filter((descriptor) =>
          isToolVisibleToAgent(db, descriptor, {
            agentId: opts.agentId ?? null,
            teamId: opts.teamId ?? null,
            connectorId: connectorOf.get(descriptor.name) ?? null,
          }),
        )
        .map((descriptor) => ({
          name: descriptor.name,
          description: describeFor(
            descriptor,
            connectorOf.get(descriptor.name) ?? null,
            grantedFor(connectorOf.get(descriptor.name) ?? null),
          ),
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
    )
  }

  /**
   * Everything served: the governed tools, plus the retrieval tool.
   *
   * `read_tool_result` is appended here rather than registered as a descriptor so
   * it can never be gated by a grant, hidden by availability, or shadowed by a
   * connector tool of the same name. The one tool that recovers a truncated
   * result has to be reachable exactly when the model is holding one.
   */
  const servedTools = (): ToolDef[] => [...toolsNow(), readToolResultTool]

  // The size ceiling. `read_tool_result` lives on THIS server because every
  // runtime attaches it, so a handle minted for a memory or tasks result is
  // redeemable here.
  const ceiling = makeResultCeiling(db, {
    agentId: opts.agentId ?? null,
    tenantId: opts.tenantId ?? null,
    ...(opts.toolResultBudgetBytes ? { budgetBytes: opts.toolResultBudgetBytes } : {}),
  })

  const server = buildServer('clawboo-tools', servedTools, ceiling)

  // Turn the declared `listChanged` capability into a real one. Best-effort: a
  // notification that fails must never take down the session it was announcing
  // a change to.
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    unsubscribe?.()
  }

  const unsubscribe = opts.onConnectorsChanged?.(() => {
    void server.sendToolListChanged?.().catch(() => {
      // `onclose` is not guaranteed: a session the client abandons without
      // closing would otherwise leave this listener in a module-level Set
      // forever, keeping a whole server object alive and taking a notification
      // on every connector change. A send that fails with NO TRANSPORT LEFT is
      // that case, and releasing here bounds the leak to one dead listener
      // until the next connector change.
      //
      // Deliberately NOT `onerror`. The SDK fires that for ordinary non-fatal
      // protocol errors, so releasing there meant one stray notification
      // permanently unsubscribed a LIVE session from connector changes, which
      // silently disables the `tools/listChanged` capability this same code
      // advertises.
      if (!server.transport) release()
    })
  })
  if (unsubscribe) {
    const previousClose = server.onclose
    server.onclose = () => {
      release()
      previousClose?.()
    }
  }

  return server
}
