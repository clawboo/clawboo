// The connector CapabilitySource: clawboo's OWN outbound MCP connections.
//
// A sixth source rather than a flag on `native`, because these rows have a
// different owner (clawboo spawned the process), a different lifecycle (they
// vanish when it is disconnected) and a different manageability tier.
//
// READ TOUCHES NO NETWORK. The supervisor already holds every live connection
// and its discovered tool list, so this is a pure projection of in-memory state.
// A source that dialled a server on every inventory read would put a network
// round-trip on the path of every graph refresh.

import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import { connectorBySlug } from '@clawboo/connector-catalog'

import { listLiveConnectors } from '../connectors/supervisor'
import { connectedAppsNow } from '../connectors/composio'
import { appForToolkit } from '@clawboo/connector-catalog'
import { buildRecord, okStatus } from './helpers'

/** The broker whose session carries the apps below. */
const COMPOSIO_SLUG = 'composio'

export class ConnectorCapabilitySource implements CapabilitySource {
  readonly id = 'connector' as const

  async read(): Promise<CapabilityReadResult> {
    const records: CapabilityRecord[] = []

    for (const live of listLiveConnectors()) {
      const def = connectorBySlug(live.slug)
      records.push(
        buildRecord({
          sourceId: 'connector',
          runtime: 'clawboo-native',
          // GLOBAL, not agent-scoped: clawboo owns the process, and every agent
          // reaches it through the same broker. Which agents may actually CALL
          // it is a grant question, not a scope one.
          scope: 'global',
          kind: 'connector',
          sourceKey: `mcp:${live.slug}`,
          origin: 'mcp-connector',
          // OBSERVE-ONLY, despite clawboo owning the process. `managed` makes the
          // Capabilities panel render enable/disable controls, and this source's
          // `write()` refuses every action -- so those buttons could only ever
          // 422. Connect and disconnect are a REST surface of their own, and
          // that is where the real controls live.
          manageability: 'observe-only',
          writable: false,
          name: def?.displayName ?? live.slug,
          description:
            def?.description ?? `Connected MCP server exposing ${live.descriptors.length} tools`,
          available: true,
          status: 'ready',
          ...(live.skipped.length > 0
            ? {
                // Surfaced on the record, so a dropped tool is visible in the
                // graph rather than only in a REST response nobody reads.
                hint: `${live.skipped.length} tool${live.skipped.length === 1 ? '' : 's'} could not be represented and were skipped`,
              }
            : {}),
        }),
      )
    }

    // ONE NODE PER APP THE AGENT CAN ACTUALLY REACH.
    //
    // A broker is one MCP session carrying many upstream apps, and reporting
    // only the session hides what that session reaches: a reader looking at a
    // node marked "Composio" has no way to know their agent can read email.
    // Naming each connected app is not decoration, it is the honest inventory,
    // and it is the only form in which a person can revoke or reason about it.
    //
    // READ FROM CACHE, NEVER FETCHED HERE. This runs on every graph rebuild, so
    // a network call would put the broker's latency inside a render. An empty
    // cache simply yields no app records, and the shelf's own refresh is what
    // fills it.
    if (records.some((r) => r.sourceKey === `mcp:${COMPOSIO_SLUG}`)) {
      const { connected } = connectedAppsNow()
      for (const toolkit of connected) {
        const app = appForToolkit(toolkit)
        if (!app) continue
        records.push(
          buildRecord({
            sourceId: 'connector',
            runtime: 'clawboo-native',
            scope: 'global',
            kind: 'connector',
            // DISTINCT FROM THE BROKER'S OWN KEY, so each app is its own node
            // rather than collapsing onto the session they share.
            // KEYED ON THE BROKER'S OWN TOOLKIT NAME, not clawboo's slug. The
            // grant this node stands for is checked against the toolkit read off
            // a call's arguments, and `google-sheets` is not what the wire
            // carries: a grant minted under our spelling would match nothing.
            sourceKey: `mcp:${COMPOSIO_SLUG}:app:${app.toolkit}`,
            origin: 'mcp-connector',
            // OBSERVE-ONLY is accurate: clawboo cannot reconfigure Gmail. It
            // does not stop the node being granted, because the drag handle is
            // gated on having a connectorId, not on manageability.
            manageability: 'observe-only',
            writable: false,
            name: app.name,
            description: app.description,
            available: true,
            status: 'ready',
          }),
        )
      }
    }

    return { records, status: okStatus('connector') }
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    // Connect and disconnect are their own REST surface, because both are far
    // more than a capability toggle: one spawns a process and performs a
    // handshake, the other reaps a process tree.
    unsupported('connector', action.kind)
  }
}
