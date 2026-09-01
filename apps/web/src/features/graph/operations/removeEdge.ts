// Unbuilding, by the same gesture that built.
//
// THE ASYMMETRY THIS CLOSES. The canvas could author three kinds of edge and
// remove exactly one: routing, and only through a Delete inside the explain
// panel. A skill installed by dropping a tile on a Boo, or a connector shared
// onto a second agent, had no removal path on the canvas at all -- the operator
// had to leave for a settings panel to undo something they had done here with a
// drag. A surface that can only add is a surface people stop trusting.
//
// ONE RULE, THREE WRITES. Select the edge, press Backspace. Which route it
// takes is decided by the edge TYPE, never by guessing from the node ids,
// because the three writes are genuinely different: a route is a markdown line,
// a skill is a capability record, and a share is a grant row.

import { disableCapability } from '@/lib/capabilitiesClient'
import { useToastStore } from '@/stores/toast'
import type { GraphEdge } from '../types'
import { useGraphStore } from '../store'
import { detachGrant } from './revokeGrant'
import { removeRouting } from './removeRouting'

/** Why an edge cannot be removed here, or null when it can. */
export function edgeRemovalRefusal(edge: GraphEdge): string | null {
  const type = edge.type ?? 'skill'
  if (type === 'dependency') return null
  if (type === 'skill') {
    // A synthetic orbital (the model tile, the Leadership badge) is a
    // graph-layer attribute rather than an installed capability. There is
    // nothing to remove and pretending otherwise would offer a delete that
    // silently does nothing.
    const d = edge.data as { capabilityId?: string; removable?: boolean }
    // A synthetic orbital (the model tile, the Leadership badge) carries no
    // capabilityId at all, so it falls out here without needing its own case.
    if (!d?.capabilityId) return 'This one is part of the agent, not something added to it.'
    if (!d.removable) return 'This came with the agent’s runtime. It cannot be removed here.'
    return null
  }
  if (type === 'grant' || type === 'resource') {
    const d = edge.data as { grantId?: string }
    return d?.grantId ? null : 'This connector is not shared through a grant.'
  }
  return 'This connection cannot be removed here.'
}

export interface RemoveEdgeContext {
  /** Display name of the agent the edge starts at. */
  sourceName: string
  /** Display name of the thing at the other end. */
  targetName: string
}

/**
 * Remove whatever this edge represents.
 *
 * Returns whether a write was attempted, so the caller can leave the selection
 * alone when the edge was refused.
 */
export async function removeEdge(edge: GraphEdge, ctx: RemoveEdgeContext): Promise<boolean> {
  const refusal = edgeRemovalRefusal(edge)
  if (refusal) {
    useToastStore.getState().addToast({ message: refusal, type: 'info' })
    return false
  }

  const type = edge.type ?? 'skill'

  if (type === 'dependency') {
    const sourceAgentId = edge.source.startsWith('boo-') ? edge.source.slice(4) : null
    const targetAgentId = edge.target.startsWith('boo-') ? edge.target.slice(4) : null
    if (!sourceAgentId || !targetAgentId) return false
    await removeRouting(edge.id, sourceAgentId, targetAgentId)
    return true
  }

  if (type === 'grant' || type === 'resource') {
    const grantId = (edge.data as { grantId?: string })?.grantId
    if (!grantId) return false
    // Carries its own 8s Undo, because a revoke is reversible for a short
    // server-side window and this is the house precedent for it.
    await detachGrant({ grantId, connectorName: ctx.targetName, agentName: ctx.sourceName })
    return true
  }

  const capabilityId = (edge.data as { capabilityId?: string })?.capabilityId
  if (!capabilityId) return false
  const result = await disableCapability(capabilityId)
  if (!result.ok) {
    useToastStore.getState().addToast({
      message: `Could not remove ${ctx.targetName}. Nothing changed.`,
      type: 'error',
    })
    return false
  }
  useGraphStore.getState().triggerRefresh()
  useToastStore.getState().addToast({
    message: `${ctx.targetName} removed from ${ctx.sourceName}.`,
    type: 'info',
  })
  return true
}
