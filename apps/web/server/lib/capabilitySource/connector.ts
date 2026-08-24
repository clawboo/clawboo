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
import { buildRecord, okStatus } from './helpers'

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

    return { records, status: okStatus('connector') }
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    // Connect and disconnect are their own REST surface, because both are far
    // more than a capability toggle: one spawns a process and performs a
    // handshake, the other reaps a process tree.
    unsupported('connector', action.kind)
  }
}
