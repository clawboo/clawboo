/**
 * apps/web/src/lib/defaultAgentSource.ts
 *
 * The runtime a new agent goes to when nobody picked one: Create Boo and the
 * graph's New agent (a thread let go on empty canvas, or the + button).
 */

import { fetchRegistryHealth } from '@clawboo/control-client'

/** The two runtimes a new agent can get without anyone choosing. */
export type DefaultAgentSource = 'openclaw' | 'clawboo-native'

/**
 * The rule itself: OpenClaw while the SERVER's Gateway connection is up,
 * otherwise Clawboo Native, which runs inside the server and needs no Gateway.
 *
 * The server's connection and not this browser's: `POST /api/agents` creates an
 * OpenClaw agent through the server's own Gateway client, so a live browser
 * connection beside a down server one would still end in a 503.
 */
export function agentSourceFor(serverGatewayConnected: boolean): DefaultAgentSource {
  return serverGatewayConnected ? 'openclaw' : 'clawboo-native'
}

/**
 * The rule, read from the server's registry health.
 *
 * Callers pass the result to `POST /api/agents` as `sourceId`. Leaving it out
 * sends the agent to OpenClaw unconditionally, and with no Gateway that is a
 * 503 (`gateway_disconnected`) and no agent.
 */
export async function defaultAgentSource(): Promise<DefaultAgentSource> {
  const health = await fetchRegistryHealth()
  return agentSourceFor(health.connection === 'connected')
}
