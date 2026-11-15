// The running agent host, once the startup check has passed.
//
// Set once at boot (`startAgentUser` in `boot.ts`) and read by the spawn seam
// and the agent-space file verbs. With agent isolation off it is never set and
// nothing reads it.

import type { AgentHostClient } from './client'
import type { AgentUserConfig } from './config'
import type { AgentPool } from './poolHosts'
import type { HelloFrame } from './protocol'

export interface ActiveAgentHost {
  client: AgentHostClient
  hello: HelloFrame
  config: AgentUserConfig
}

let active: ActiveAgentHost | null = null

/** The agent host is not running: before the startup check, or after it died. */
export class AgentHostUnavailableError extends Error {
  readonly code = 'EAGENTHOST'
  constructor(detail?: string) {
    super(
      `Agents run as a separate user (CLAWBOO_AGENT_USER), and the agent host that starts them is not running${detail ? `: ${detail}` : ''}.`,
    )
    this.name = 'AgentHostUnavailableError'
  }
}

export function setActiveAgentHost(next: ActiveAgentHost | null): void {
  active = next
}

/** The running host, or a throw that says why there is none. With a user per
 *  agent there is no single host: callers pick one by agent or by path
 *  (`poolRoute.ts`). */
export function activeAgentHost(): ActiveAgentHost {
  if (pool) {
    throw new AgentHostUnavailableError(
      'each agent runs as its own user (CLAWBOO_AGENT_USERS), so this needs the agent it is for',
    )
  }
  if (!active) throw new AgentHostUnavailableError()
  if (active.client.closed) throw new AgentHostUnavailableError(active.client.closed)
  return active
}

/** The running host, or null. */
export function peekAgentHost(): ActiveAgentHost | null {
  return active
}

/** The agent user's home folder, as the host reported it. */
export function agentHomeDir(): string {
  return activeAgentHost().hello.home
}

// ── A user per agent (CLAWBOO_AGENT_USERS) ──────────────────────────────

let pool: AgentPool | null = null

export function setActiveAgentPool(next: AgentPool | null): void {
  pool = next
}

/** The pool's hosts, or a throw when the pool is not running. */
export function activeAgentPool(): AgentPool {
  if (!pool) throw new AgentHostUnavailableError('the agent user pool has not started')
  return pool
}

/** The pool's hosts, or null. */
export function peekAgentPool(): AgentPool | null {
  return pool
}
