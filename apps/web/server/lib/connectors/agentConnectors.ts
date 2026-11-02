// Which live connectors one agent may use, for the words an agent is told.
//
// A connector the user connected is not a connector every agent may use: access
// is shared per agent on the graph. The connectors clause used to name every
// live connector to every agent, which told an agent that apps it was never
// given were "usable right now" and told it which apps the user had connected
// for other agents. This asks the same question the MCP tool list asks
// (`isToolVisibleToAgent`), so the clause never names a connector whose tools
// the agent cannot see.

import { isToolVisibleToAgent, type ClawbooDb } from '@clawboo/db'

import type { LiveConnector } from './supervisor'

export interface AgentConnectors {
  /** Live and shared with this agent: its tools are in the agent's tool list. */
  connected: string[]
  /** Live for the install but not shared with this agent. Never name these to it. */
  unshared: string[]
}

export function connectorsForAgent(
  db: ClawbooDb,
  live: readonly Pick<LiveConnector, 'connectorId' | 'slug' | 'descriptors'>[],
  ctx: { agentId: string; teamId?: string | null },
): AgentConnectors {
  const connected: string[] = []
  const unshared: string[] = []
  for (const c of live) {
    const visible = c.descriptors.some((d) =>
      isToolVisibleToAgent(db, d, {
        agentId: ctx.agentId,
        teamId: ctx.teamId ?? null,
        connectorId: c.connectorId,
      }),
    )
    ;(visible ? connected : unshared).push(c.slug)
  }
  return { connected, unshared }
}
