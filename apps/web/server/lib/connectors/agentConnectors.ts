// Which live connectors one agent can use, for the words an agent is told.
//
// A connector the user connected is not a connector every agent may use: access
// is shared per agent on the graph. The connectors clause used to name every
// live connector to every agent, which told an agent that apps it was never
// given were "usable right now" and told it which apps the user had connected
// for other agents. This asks the same question the agent's own connector tool
// list is built with (`isToolVisibleToAgent`), under the same identity, so the
// clause never names a connector whose tools the agent cannot see.

import { isToolVisibleToAgent, type ClawbooDb } from '@clawboo/db'

import { loadAgentConfigOrDefault } from '../runtimes/native/agentConfigStore'
import type { LiveConnector } from './supervisor'

export interface AgentConnectors {
  /** Live and in the agent's tool list. */
  connected: string[]
  /** Live for the install but not in the agent's tool list. Never name these to it. */
  unshared: string[]
}

type LiveSlice = readonly Pick<LiveConnector, 'connectorId' | 'slug' | 'descriptors'>[]

/**
 * Split live connectors by what this identity's tool list holds. A null
 * `agentId` and `teamId` is an unbound session, which sees only tools granted to
 * everyone.
 */
export function connectorsForAgent(
  db: ClawbooDb,
  live: LiveSlice,
  ctx: { agentId: string | null; teamId?: string | null },
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

/**
 * The connectors a run on this agent's runtime actually holds.
 *
 * Not every runtime builds its tool list under the agent's own identity:
 * - OpenClaw reaches Clawboo's tools through one Gateway setting all OpenClaw
 *   agents share, so its session is unbound and holds only tools granted to
 *   everyone. The browser grants every agent gets at first start are its own,
 *   so an OpenClaw agent never sees them.
 * - Clawboo Native attaches no Tools server, and so no connector tools at all,
 *   when its config switches Tools off.
 * Every other runtime attaches the Tools server bound to the agent and its team.
 */
export function connectorsForRun(
  db: ClawbooDb,
  live: LiveSlice,
  run: { agentId: string; teamId: string | null; runtime: string | null },
): AgentConnectors {
  if (run.runtime === 'openclaw') {
    return connectorsForAgent(db, live, { agentId: null, teamId: null })
  }
  if (run.runtime === 'clawboo-native' && !loadAgentConfigOrDefault(db, run.agentId).tools.tools) {
    return { connected: [], unshared: live.map((c) => c.slug) }
  }
  return connectorsForAgent(db, live, { agentId: run.agentId, teamId: run.teamId })
}
