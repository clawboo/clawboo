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

import type { CapabilityHealth, CapabilityRecord } from '@clawboo/capability-registry'
import type { GrantDenyReason } from '@clawboo/governance'
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
    grantState: 'active',
    grantMode: grant.mode,
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
      // HEALTH, projected from the two places that actually know it.
      //
      // Without this the whole upper half of the badge ladder was unreachable:
      // `drift` in particular, which is the highest-signal state there is. A
      // rug-pulled connector rendered as a healthy active grant while the broker
      // denied every call under it, which is precisely the disagreement between
      // the picture and the enforcement that this projection exists to prevent.
      //
      // Drift wins over the stored row: the connector is answering fine, and
      // that is the point. The remediation is to re-read what changed, not to
      // retry.
      ...connectorHealth(preview?.denyReason ?? null, connector),
      // Only an OPERATOR grant surfaces as `grantId`, because that field is what
      // makes the tile render an edge and a Detach button. An owner grant is
      // real, gates real calls, and stays invisible.
      ...(preview && holders.find((g) => g.id === preview.grantId)?.origin === 'operator'
        ? {
            grantId: preview.grantId,
            grantState: preview.state,
            grantMode: preview.mode,
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
      const alreadyReal = out.some(
        (r) => r.agentId === g.subjectId && connectorIdForRecord(r) === connectorId,
      )
      if (alreadyReal) continue

      // Gate on what the GATE would decide for the recipient, not on `g.state`.
      // A row can sit stored as `active` while `decideGrant` refuses it -- past
      // its expiry, out-scoped by a deny, or drifted -- and a tile for a
      // connector the broker will refuse is exactly the lie this design exists
      // to prevent.
      const recipientConnector = getConnector(db, connectorId)
      const effective = previewGrant({
        grants: listCandidateGrants(db, { agentId: g.subjectId, connectorId }),
        currentSpecHash: recipientConnector?.specHash ?? null,
        currentToolsHash: recipientConnector?.toolsHash ?? null,
        now,
      })
      if (!effective || effective.grantId !== g.id || effective.denyReason !== null) continue
      out.push(syntheticTwin(source, g))
    }
  }

  return out
}

/**
 * The live health of one connector tile.
 *
 * Two inputs, in priority order. A DRIFT verdict comes from the gate itself, so
 * it is the same fact the broker would act on. Otherwise the `connectors` row
 * carries whatever the supervisor last recorded, which is `ok` while it is
 * running and an error once something noticed it was not.
 */
function connectorHealth(
  denyReason: GrantDenyReason | null,
  connector: { health?: string | null; healthDetail?: string | null } | null,
): { health: CapabilityHealth; healthDetail?: string | null } {
  if (denyReason === 'spec-drift') {
    return {
      health: 'drift',
      healthDetail: 'this connector no longer matches what was approved for it',
    }
  }
  const stored = connector?.health
  if (stored === 'error' || stored === 'degraded' || stored === 'needs-auth') {
    return {
      health: stored,
      ...(connector?.healthDetail ? { healthDetail: connector.healthDetail } : {}),
    }
  }
  return { health: connector ? 'ok' : 'unknown' }
}
