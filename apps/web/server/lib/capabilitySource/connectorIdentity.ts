// The one place a connector's STABLE, AGENT-INDEPENDENT identity is derived.
//
// Why this exists at all: `capabilities.id` folds the owning agent into its raw
// key (`buildRecord` builds `${runtime}:${scope}:${agentId}:${kind}:${sourceKey}`),
// so two agents attached to the SAME MCP server carry two unrelated capability
// ids. Keying a grant on one of them would make the granting agent's row
// unfindable by the grantee's broker, which is the single lookup that has to
// work for a share to mean anything.
//
// So a grant is keyed on this instead. It deliberately contains `:` and is NOT
// derivable from an MCP tool name -- the broker takes it from its caller rather
// than parsing it back out of a namespaced tool, which is why
// `ToolCallContext.connectorId` exists.

import type { CapabilityRecord } from '@clawboo/capability-registry'

import { parseCapabilityId } from '@clawboo/capability-registry'

/**
 * `conn:<sourceId>:<runtime>:<sourceKey>`.
 *
 * The three components are exactly the ones that identify the SERVER rather
 * than the attachment: which adapter owns it, which runtime it runs under, and
 * its key inside that runtime. Agent and scope are excluded on purpose.
 *
 */
export function connectorIdFor(sourceId: string, runtime: string, sourceKey: string): string {
  return `conn:${sourceId}:${runtime}:${sourceKey}`
}

/**
 * The identity for a capability RECORD.
 *
 * Returns null for a record that is not a connector, so a caller cannot
 * accidentally mint a grant identity for a skill.
 */
export function connectorIdForRecord(record: CapabilityRecord): string | null {
  if (record.kind !== 'connector') return null
  const sourceId = parseCapabilityId(record.id)?.sourceId ?? null
  if (!sourceId) return null
  return connectorIdFor(sourceId, record.runtime, record.sourceKey)
}

/**
 * The identity for a connector clawboo itself spawned.
 *
 * MUST equal what `connectorIdForRecord` derives from the record the connector
 * source emits for the same connector, or the grant the supervisor keys on and
 * the grant the projection looks up are different rows -- the tile gets an owner
 * grant under one id while the broker denies `no-grant` under another. Built
 * from the same function, and pinned by a test, because the two producers are in
 * different files and nothing else would catch them drifting.
 */
export const CONNECTOR_SOURCE_RUNTIME = 'clawboo-native'

export function connectorInstanceIdForSlug(slug: string): string {
  return connectorIdFor('connector', CONNECTOR_SOURCE_RUNTIME, `mcp:${slug}`)
}
