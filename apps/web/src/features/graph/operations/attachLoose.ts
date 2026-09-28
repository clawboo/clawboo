// Give an agent the thing a loose node stands for.
//
// The same writes the thread picker makes when a thread pulled off a Boo ends
// in a skill or connector: a skill install, or a connector grant at write access
// with risky calls asking first. The only difference is the order the operator
// did things in: here the thing was put on the canvas first and the agent chosen
// after, by dropping onto it.

import { connectorBySlug } from '@clawboo/connector-catalog'

import { BUILTIN_SKILLS } from '@/features/marketplace/catalog'
import { connectConnector } from '@/features/marketplace/connectConnector'
import { useToastStore } from '@/stores/toast'

import { useLooseNodeStore, type LooseNodeData } from '../looseNodes'
import { connectorSlugFromId } from '../nodes/connectorTile'
import { grantConnectorToAgent } from './grantConnector'
import { installSkillForAgent } from './installSkill'

/** The part of a canvas node this needs: enough to see what an agent holds. */
interface HeldNode {
  id: string
  type?: string
  data: unknown
}

/**
 * Whether the agent already holds what the loose node stands for, read off the
 * canvas the same way the thread picker leaves held rows out.
 */
export function agentAlreadyHas(
  nodes: readonly HeldNode[],
  agentId: string,
  loose: Pick<LooseNodeData, 'kind' | 'ref' | 'name'>,
): boolean {
  for (const n of nodes) {
    const d = (n.data ?? {}) as { name?: string; connectorId?: string | null }
    if (loose.kind === 'skill') {
      if (n.type === 'skill' && n.id.startsWith(`skill-${agentId}-`) && d.name === loose.name) {
        return true
      }
      continue
    }
    if (n.type !== 'resource' || !n.id.startsWith(`resource-${agentId}-`)) continue
    if (loose.kind === 'connector' && connectorSlugFromId(d.connectorId ?? null) === loose.ref) {
      return true
    }
    if (loose.kind === 'app' && (d.connectorId ?? '').endsWith(`:app:${loose.ref}`)) return true
  }
  return false
}

/**
 * Give `agentId` the thing, and on success take the loose node off its canvas:
 * the agent's own tile, which the server owns, takes its place. Resolves true
 * once the agent has it.
 */
export async function attachLooseToAgent(
  loose: LooseNodeData,
  nodeId: string,
  agentId: string,
  agentName: string,
): Promise<boolean> {
  let ok = false
  if (loose.kind === 'skill') {
    const skill = BUILTIN_SKILLS.find((s) => s.id === loose.ref)
    if (!skill) {
      useToastStore
        .getState()
        .addToast({ message: `${loose.name} is no longer offered.`, type: 'error' })
      return false
    }
    ok = await installSkillForAgent(skill.name, agentId, agentName)
  } else {
    // THE IDENTITY COMES FROM THE SERVER, as it does for the thread picker. The
    // connector was turned on when it was placed, so this is a lookup; if it
    // has since been turned off, the same route turns it back on. Quiet, since
    // announcing "connected" here would report something the operator did not
    // just ask for. Failures still speak.
    const def = loose.kind === 'connector' ? connectorBySlug(loose.ref) : null
    if (loose.kind === 'connector' && !def) {
      useToastStore
        .getState()
        .addToast({ message: `${loose.name} is no longer available.`, type: 'error' })
      return false
    }
    const session =
      loose.kind === 'connector'
        ? await connectConnector(loose.ref, def?.displayName ?? loose.name, undefined, true)
        : await connectConnector('composio', 'Composio', undefined, true)
    if (!session) return false
    ok = await grantConnectorToAgent(
      {
        targetAgentId: agentId,
        connectorId:
          loose.kind === 'connector'
            ? session.connectorId
            : `${session.connectorId}:app:${loose.ref}`,
        capabilityId: null,
        // WRITE, for the reason the thread picker gives: a read grant denies
        // nearly every call, which looks exactly like a broken connector.
        mode: 'write',
        approvalPolicy: 'risk',
      },
      { connectorName: loose.name, targetAgentName: agentName },
    )
  }
  if (ok) useLooseNodeStore.getState().remove(loose.canvasKey, nodeId)
  return ok
}
