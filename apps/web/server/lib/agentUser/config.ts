// The agent-user settings, read from the environment.
//
// CLAWBOO_AGENT_USER=<name> turns agent isolation on: everything that runs
// model-directed work runs as that OS user. Unset (the default), nothing here
// changes how Clawboo runs.

export type AgentSwitch = 'sudo' | 'doas'

export interface AgentUserConfig {
  /** The agent user's name. */
  user: string
  /** How the server starts the agent host as that user, on a computer or VM. */
  switch: AgentSwitch
  /** Set when a container launcher started the host: the socket to reach it on. */
  socket: string | null
}

export class AgentUserConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentUserConfigError'
  }
}

/** A user name sudo, doas and the account tools all take. */
const USER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/

/** Whether agent isolation is on. */
export function isAgentUserMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['CLAWBOO_AGENT_USER'] ?? '').trim() !== ''
}

/** The settings, or null when agent isolation is off. Throws on a malformed one. */
export function resolveAgentUserConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentUserConfig | null {
  const user = (env['CLAWBOO_AGENT_USER'] ?? '').trim()
  if (!user) return null
  if (!USER_NAME_RE.test(user)) {
    throw new AgentUserConfigError(
      `CLAWBOO_AGENT_USER=${JSON.stringify(user)} is not a user name. Use letters, digits, '_', '-' or '.', starting with a letter or '_'.`,
    )
  }
  const sw = (env['CLAWBOO_AGENT_SWITCH'] ?? 'sudo').trim() || 'sudo'
  if (sw !== 'sudo' && sw !== 'doas') {
    throw new AgentUserConfigError(`CLAWBOO_AGENT_SWITCH=${JSON.stringify(sw)}: use sudo or doas.`)
  }
  const socket = (env['CLAWBOO_AGENT_HOST_SOCKET'] ?? '').trim() || null
  if (socket !== null && !socket.startsWith('/')) {
    throw new AgentUserConfigError(
      `CLAWBOO_AGENT_HOST_SOCKET must be an absolute path, got ${JSON.stringify(socket)}.`,
    )
  }
  return { user, switch: sw, socket }
}
