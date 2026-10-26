/**
 * apps/web/src/lib/defaultAgentSource.ts
 *
 * The runtime a new agent goes to when nobody picked one: Create Boo and the
 * graph's New agent (a thread let go on empty canvas, or the + button).
 */

import { fetchRegistryHealth } from '@clawboo/control-client'

import { useConnectionStore } from '@/stores/connection'

/** The two runtimes a new agent can get without anyone choosing. */
export type DefaultAgentSource = 'openclaw' | 'clawboo-native'

/** Whether this browser holds a live Gateway connection right now. */
export function browserGatewayLive(): boolean {
  const { status, client } = useConnectionStore.getState()
  return status === 'connected' && client !== null
}

/**
 * The rule itself: OpenClaw while its Gateway is reachable, from this browser
 * or through the server's own connection (a thin client has only the second).
 * Otherwise Clawboo Native, which runs inside the server and needs no Gateway.
 */
export function agentSourceFor(gateway: { browser: boolean; server: boolean }): DefaultAgentSource {
  return gateway.browser || gateway.server ? 'openclaw' : 'clawboo-native'
}

/**
 * The rule, asking the server only when this browser has no Gateway.
 *
 * Callers pass the result to `POST /api/agents` as `sourceId`. Leaving it out
 * sends the agent to OpenClaw unconditionally, and with no Gateway that is a
 * 503 (`gateway_disconnected`) and no agent.
 */
export async function defaultAgentSource(): Promise<DefaultAgentSource> {
  if (browserGatewayLive()) return 'openclaw'
  const health = await fetchRegistryHealth()
  return agentSourceFor({ browser: false, server: health.connection === 'connected' })
}
