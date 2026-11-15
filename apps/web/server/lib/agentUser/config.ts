// The agent-user settings, read from the environment.
//
// Two ways to turn agent isolation on, never both:
// - CLAWBOO_AGENT_USER=<name>: everything that runs model-directed work runs as
//   that one OS user. Agents are walled off from Clawboo, not from each other.
// - CLAWBOO_AGENT_USERS=<pool>: each agent runs as a user of its own, taken from
//   that pool when the agent is created and kept for its life. Team folders are
//   shared through a group per team, from CLAWBOO_AGENT_GROUPS.
//
// Unset (the default), nothing here changes how Clawboo runs.

export type AgentSwitch = 'sudo' | 'doas'

export interface AgentUserConfig {
  /** The agent user's name. */
  user: string
  /** How the server starts the agent host as that user, on a computer or VM. */
  switch: AgentSwitch
  /** Set when a container launcher started the host: the socket to reach it on. */
  socket: string | null
  /**
   * The group the host runs with instead of the user's own (sudo `-g`): a
   * pooled agent's team group. Null for the user's own group.
   */
  group?: string | null
}

/** A pool of OS users or groups, as the operator wrote it. */
export type PoolSpec =
  | { kind: 'names'; names: string[] }
  /** Every id from `lo` to `hi`, both included; names come from the account database. */
  | { kind: 'range'; lo: number; hi: number }

export interface AgentPoolConfig {
  /** The agent users (CLAWBOO_AGENT_USERS). */
  users: PoolSpec
  /** The team groups (CLAWBOO_AGENT_GROUPS); null when none were given. */
  groups: PoolSpec | null
  /** How the server starts each agent's host. */
  switch: AgentSwitch
}

export class AgentUserConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentUserConfigError'
  }
}

/** A user name sudo, doas and the account tools all take. */
export const USER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/

/** The largest pool Clawboo takes: each member may get a host of its own. */
export const MAX_POOL_SIZE = 1000

/** Whether agent isolation is on, with one agent user or with a pool. */
export function isAgentUserMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env['CLAWBOO_AGENT_USER'] ?? '').trim() !== '' ||
    (env['CLAWBOO_AGENT_USERS'] ?? '').trim() !== ''
  )
}

/** Whether each agent runs as a user of its own (CLAWBOO_AGENT_USERS). */
export function isAgentPoolMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['CLAWBOO_AGENT_USERS'] ?? '').trim() !== ''
}

function resolveSwitch(env: NodeJS.ProcessEnv): AgentSwitch {
  const sw = (env['CLAWBOO_AGENT_SWITCH'] ?? 'sudo').trim() || 'sudo'
  if (sw !== 'sudo' && sw !== 'doas') {
    throw new AgentUserConfigError(`CLAWBOO_AGENT_SWITCH=${JSON.stringify(sw)}: use sudo or doas.`)
  }
  return sw
}

function refuseBoth(env: NodeJS.ProcessEnv): void {
  if ((env['CLAWBOO_AGENT_USER'] ?? '').trim() && (env['CLAWBOO_AGENT_USERS'] ?? '').trim()) {
    throw new AgentUserConfigError(
      'Set CLAWBOO_AGENT_USER (one agent user for every agent) or CLAWBOO_AGENT_USERS (a user per agent), not both.',
    )
  }
}

/** The one-user settings, or null when CLAWBOO_AGENT_USER is unset. Throws on a malformed one. */
export function resolveAgentUserConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentUserConfig | null {
  const user = (env['CLAWBOO_AGENT_USER'] ?? '').trim()
  if (!user) return null
  refuseBoth(env)
  if (!USER_NAME_RE.test(user)) {
    throw new AgentUserConfigError(
      `CLAWBOO_AGENT_USER=${JSON.stringify(user)} is not a user name. Use letters, digits, '_', '-' or '.', starting with a letter or '_'.`,
    )
  }
  const sw = resolveSwitch(env)
  const socket = (env['CLAWBOO_AGENT_HOST_SOCKET'] ?? '').trim() || null
  if (socket !== null && !socket.startsWith('/')) {
    throw new AgentUserConfigError(
      `CLAWBOO_AGENT_HOST_SOCKET must be an absolute path, got ${JSON.stringify(socket)}.`,
    )
  }
  return { user, switch: sw, socket }
}

/**
 * Read a pool: a comma-separated list of names, or `<prefix>:<lo>-<hi>` for a
 * range of ids (`uid:` for users, `gid:` for groups). Names may repeat only by
 * mistake, so a repeat is refused; a range is refused past MAX_POOL_SIZE.
 */
export function parsePoolSpec(raw: string, varName: string, idPrefix: 'uid' | 'gid'): PoolSpec {
  const text = raw.trim()
  const range = new RegExp(`^${idPrefix}:(\\d{1,10})-(\\d{1,10})$`).exec(text)
  if (range) {
    const lo = Number(range[1])
    const hi = Number(range[2])
    if (lo < 1 || hi < lo) {
      throw new AgentUserConfigError(
        `${varName}=${JSON.stringify(text)}: the range must run from a smaller id to a larger one, above 0.`,
      )
    }
    if (hi - lo + 1 > MAX_POOL_SIZE) {
      throw new AgentUserConfigError(
        `${varName}=${JSON.stringify(text)} names ${hi - lo + 1} ids; at most ${MAX_POOL_SIZE} are taken.`,
      )
    }
    return { kind: 'range', lo, hi }
  }
  if (text.includes(':')) {
    throw new AgentUserConfigError(
      `${varName}=${JSON.stringify(text)}: write names separated by commas, or a range such as ${idPrefix}:20001-20032.`,
    )
  }
  const names = text
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  if (names.length === 0) {
    throw new AgentUserConfigError(`${varName} is set but names nobody.`)
  }
  if (names.length > MAX_POOL_SIZE) {
    throw new AgentUserConfigError(
      `${varName} names ${names.length} entries; at most ${MAX_POOL_SIZE} are taken.`,
    )
  }
  const seen = new Set<string>()
  for (const n of names) {
    if (!USER_NAME_RE.test(n)) {
      throw new AgentUserConfigError(
        `${varName}: ${JSON.stringify(n)} is not a name. Use letters, digits, '_', '-' or '.', starting with a letter or '_'.`,
      )
    }
    if (seen.has(n)) throw new AgentUserConfigError(`${varName} names ${n} twice.`)
    seen.add(n)
  }
  return { kind: 'names', names }
}

/** The pool settings, or null when CLAWBOO_AGENT_USERS is unset. Throws on a malformed one. */
export function resolveAgentPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentPoolConfig | null {
  const users = (env['CLAWBOO_AGENT_USERS'] ?? '').trim()
  if (!users) return null
  refuseBoth(env)
  if ((env['CLAWBOO_AGENT_HOST_SOCKET'] ?? '').trim()) {
    throw new AgentUserConfigError(
      'CLAWBOO_AGENT_HOST_SOCKET reaches one agent host, and CLAWBOO_AGENT_USERS runs a host per agent. A container launcher for a pool is not available yet: start agents through sudo or doas.',
    )
  }
  const groups = (env['CLAWBOO_AGENT_GROUPS'] ?? '').trim()
  return {
    users: parsePoolSpec(users, 'CLAWBOO_AGENT_USERS', 'uid'),
    groups: groups ? parsePoolSpec(groups, 'CLAWBOO_AGENT_GROUPS', 'gid') : null,
    switch: resolveSwitch(env),
  }
}
