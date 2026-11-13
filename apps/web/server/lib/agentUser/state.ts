// The running agent host, once the startup check has passed.
//
// Set once at boot (`startAgentUser` in `boot.ts`) and read by the spawn seam
// and the agent-space file verbs. With agent isolation off it is never set and
// nothing reads it.

import type { AgentHostClient } from './client'
import type { AgentUserConfig } from './config'
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

/** The running host, or a throw that says why there is none. */
export function activeAgentHost(): ActiveAgentHost {
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
