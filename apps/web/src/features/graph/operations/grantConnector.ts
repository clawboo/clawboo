// Grant an already-connected connector to a second agent (J4, "the twin").
//
// Reachable ONLY through a grant-backed tile's source handle, which renders only
// when the record carries a grantId — i.e. only once the server actually serves
// grants. So this op can honestly target the grants API: by the time any
// user can fire it, the endpoint exists. Shipping the button and the endpoint in
// the same release is the rule; this is the gesture-side half.
//
// Optimistic-with-rollback is deliberately NOT done here for the node itself:
// a tile claims a capability exists for that agent, and tiles are never staged
// (Principle 4). The refresh pulls the server's truth; the edge and tile arrive
// together from the reconciled inventory.

import { apiFetch } from '@clawboo/control-client'
import { useToastStore } from '@/stores/toast'
import { useGraphStore } from '../store'

export interface GrantConnectorRequest {
  capabilityId: string | null
  connectorId: string | null
  targetAgentId: string
  mode: 'read' | 'write' | 'admin'
  /** Maps to `approval_policy`. The composer defaults to `risk`. */
  approvalPolicy: 'never' | 'risk' | 'writes' | 'always'
}

const MODE_LABEL: Record<GrantConnectorRequest['mode'], string> = {
  read: 'Read access',
  write: 'Write access',
  admin: 'Admin access',
}

export async function grantConnectorToAgent(
  req: GrantConnectorRequest,
  display: { connectorName: string; targetAgentName: string },
): Promise<boolean> {
  let res: Response
  try {
    res = await apiFetch('/api/grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subjectKind: 'agent',
        subjectId: req.targetAgentId,
        capabilityKind: 'connector',
        connectorId: req.connectorId,
        capabilityId: req.capabilityId,
        mode: req.mode,
        approvalPolicy: req.approvalPolicy,
      }),
    })
  } catch {
    useToastStore.getState().addToast({
      message: `Could not reach the server. ${display.connectorName} was not shared.`,
      type: 'error',
    })
    return false
  }

  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined)
    useToastStore.getState().addToast({
      message: `Could not share ${display.connectorName}: ${detail ?? `HTTP ${res.status}`}`,
      type: 'error',
    })
    return false
  }

  // The reconciled inventory is the source of truth for the twin tile + edge;
  // refresh rather than hand-crafting nodes the server will re-derive anyway.
  useGraphStore.getState().triggerRefresh()
  useToastStore.getState().addToast({
    message: `${display.connectorName} shared with ${display.targetAgentName}. ${
      MODE_LABEL[req.mode]
    }, risky calls ask first.`,
    type: 'success',
  })
  return true
}
