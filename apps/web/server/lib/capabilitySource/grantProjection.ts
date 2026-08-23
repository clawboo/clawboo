// Stamp grant facts onto the capability inventory.
//
// THE COUPLING LIVES HERE. Every grant field a renderer reads comes from
// `previewGrant`, which runs the same `decideGrant` the broker's gate runs over
// the same rows returned by the same `listCandidateGrants`. There is no second
// grant reader and no second key derivation, so a badge cannot assert a verdict
// the runtime would not reach.
//
// TWO ORIGINS, ONE TABLE, DIFFERENT MEANINGS:
//   owner    minted here because the runtime's own config already attaches this
//            connector to this agent. It closes the gate's hole (an agent
//            calling its own connector must resolve to SOMETHING) and is
//            deliberately NOT rendered as an edge: the tile already says
//            "this agent has this connector", and drawing a second thing that
//            says the same is noise with a Detach button on it.
//   operator a human dragged a tile onto another Boo. THIS is what draws an edge
//            and what Detach revokes.

import type { CapabilityRecord } from '@clawboo/capability-registry'
import {
  ensureOwnerGrant,
  getConnector,
  lastUsedByGrant,
  listCandidateGrants,
  listGrants,
  pendingApprovalsByGrant,
  previewGrant,
  type ClawbooDb,
  type GrantRow,
} from '@clawboo/db'

import { connectorIdForRecord } from './connectorIdentity'

/** A grantee's tile for a connector its own runtime never reported. */
function syntheticTwin(source: CapabilityRecord, grant: GrantRow): CapabilityRecord {
  return {
    ...source,
    // Distinct id, so it cannot collide with the granter's row in the
    // fresh-wins dedup. It resolves through no table, which is what `synthetic`
    // warns every consumer about.
    id: `${source.id}#grant:${grant.id}`,
    scope: 'agent',
    agentId: grant.subjectId,
    // A grantee cannot reconfigure someone else's connector.
    writable: false,
    manageability: 'observe-only',
    synthetic: true,
    connectorId: grant.connectorId,
    grantId: grant.id,
  }
}

/**
 * Project grants onto the inventory, minting the owner grant that makes a
 * connector tile grant-backed in the first place.
 *
 * Runs on every capability read, so every write here is insert-or-nothing:
 * `ensureOwnerGrant` never updates, which is what stops the next refresh from
 * resurrecting a grant an operator just revoked.
 */
export function projectGrants(db: ClawbooDb, records: CapabilityRecord[]): CapabilityRecord[] {
  const connectors = records.filter((r) => r.kind === 'connector')
  if (connectors.length === 0) return records

  // 1. Owner grants: one per (agent, connector) the runtime already attaches.
  for (const record of connectors) {
    const connectorId = connectorIdForRecord(record)
    if (!connectorId) continue
    ensureOwnerGrant(db, {
      subjectKind: record.agentId ? 'agent' : 'global',
      subjectId: record.agentId,
      capabilityKind: 'connector',
      connectorId,
      capabilityId: null,
    })
  }

  // 2. One read of everything, so the projection is O(1) queries rather than
  //    O(records). `triggerRefresh` re-issues an unfiltered inventory read after
  //    every grant gesture, so this path is hotter than it looks.
  const all = listGrants(db)
  const ids = all.map((g) => g.id)
  const lastUsed = lastUsedByGrant(db, ids)
  const pending = pendingApprovalsByGrant(db, ids)
  const now = Date.now()

  const out: CapabilityRecord[] = []
  const byConnector = new Map<string, GrantRow[]>()
  for (const g of all) {
    if (!g.connectorId) continue
    const arr = byConnector.get(g.connectorId) ?? []
    arr.push(g)
    byConnector.set(g.connectorId, arr)
  }

  for (const record of records) {
    const connectorId = record.kind === 'connector' ? connectorIdForRecord(record) : null
    if (!connectorId) {
      out.push(record)
      continue
    }

    const candidates = listCandidateGrants(db, { agentId: record.agentId, connectorId })
    const connector = getConnector(db, connectorId)
    const preview = previewGrant({
      grants: candidates,
      currentSpecHash: connector?.specHash ?? null,
      currentToolsHash: connector?.toolsHash ?? null,
      now,
    })

    const holders = byConnector.get(connectorId) ?? []
    out.push({
      ...record,
      connectorId,
      // Only an OPERATOR grant surfaces as `grantId`, because that field is what
      // makes the tile render an edge and a Detach button. An owner grant is
      // real, gates real calls, and stays invisible.
      ...(preview && holders.find((g) => g.id === preview.grantId)?.origin === 'operator'
        ? {
            grantId: preview.grantId,
            grantState: preview.state,
            lastUsedAt: lastUsed.has(preview.grantId)
              ? new Date(lastUsed.get(preview.grantId)!).toISOString()
              : null,
            pendingApprovals: pending.get(preview.grantId) ?? 0,
          }
        : {}),
      // The shared "xN" chip counts every ACTIVE holder, owner grants included:
      // the operator question is "how many agents can reach this", not "how many
      // did I personally share it with".
      grantCount: holders.filter((g) => g.state === 'active').length,
    })
  }

  // 3. Twin tiles: an operator grant whose subject has no record of its own.
  for (const [connectorId, holders] of byConnector) {
    const source = out.find(
      (r) => r.kind === 'connector' && connectorIdForRecord(r) === connectorId && !r.synthetic,
    )
    if (!source) continue
    for (const g of holders) {
      if (g.origin !== 'operator' || g.subjectKind !== 'agent' || !g.subjectId) continue
      if (g.state !== 'active') continue
      const alreadyReal = out.some(
        (r) => r.agentId === g.subjectId && connectorIdForRecord(r) === connectorId,
      )
      if (alreadyReal) continue
      out.push(syntheticTwin(source, g))
    }
  }

  return out
}
