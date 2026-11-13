// When a desktop driver (Cua Driver) may run at all.
//
// A desktop driver types into whatever is on its agent's screen, the agent's
// browser included, and reads back what the screen shows. Without agents on
// their own OS user that browser runs as the person running Clawboo, so an
// address the driver types into it (`file:///.../.clawboo/...`) shows that
// person's files, Clawboo's access token and key vault among them. No check on
// a tool's arguments can see a typed address. It is the reason control links
// need agents on their own OS user, and it applies here the same way: whoever
// may use an agent can use what it holds, so the agent must hold only what its
// own user can reach.

import { isAgentUserMode } from '../agentUser/config'

/** Why a desktop driver may not run here, or null when it may. */
export function desktopDriverRefusal(
  displayName: string,
  agentUserMode: boolean = isAgentUserMode(),
): string | null {
  return agentUserMode
    ? null
    : `${displayName} needs agents to run as their own OS user (CLAWBOO_AGENT_USER). It types into the agent's browser, which otherwise runs as you, so it could open your files and Clawboo's own.`
}
