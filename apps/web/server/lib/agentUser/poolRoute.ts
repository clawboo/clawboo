// Which agent host does a piece of agent work, when each agent has its own
// user (CLAWBOO_AGENT_USERS).
//
// - A process names its agent: it runs as that agent's user, with its team's
//   group (`hostForAgent`).
// - A file names a place: under a pool user's home it is that user's; in the
//   work folder it belongs to a share, the folders of one team or of one agent
//   with no team, and goes to an agent of that share (`hostForPath`).
//
// A wrong route fails closed: a host can only reach what its user can, so a
// request sent to the wrong one is refused by the operating system, never
// carried out on someone else's files.

import { AsyncLocalStorage } from 'node:async_hooks'
// POSIX path rules on every host: a user per agent runs on Linux only, so its
// paths must not change meaning under another platform's rules (in tests too).
import { posix as path } from 'node:path'

import type { AgentHostClient } from './client'
import {
  AgentPoolShortError,
  agentOfPoolUser,
  peekPoolUserNameFor,
  poolUserNameFor,
  shareGroupNameFor,
  taskOwners,
  teamMembersWithUsers,
} from './poolAssignments'
import type { PoolUser } from './pool'
import { activeAgentPool } from './state'

/**
 * The agent whose work is under way, for work that names no agent of its own:
 * a check's verify command, its reviewer (which runs as `critic`), git on the
 * team's history. Set around that agent's check (`runAsAgent`), so such work
 * runs as the agent it checks, and never as some other teammate.
 */
const acting = new AsyncLocalStorage<string>()

/** Run `fn` with `agentId` as the agent whose work is under way. */
export function runAsAgent<T>(agentId: string, fn: () => T): T {
  return acting.run(agentId, fn)
}

/** The agent whose work is under way, or null outside `runAsAgent`. */
export function actingAgent(): string | null {
  return acting.getStore() ?? null
}

/** The prefix of a share segment that belongs to one agent with no team. */
export const AGENT_SHARE_PREFIX = '_agent-'

/** Who owns a folder in the work folder. `prefer`: the agent that should act
 *  for a team's folder when it is one of the team (a task's assignee). */
export type ShareOwner =
  { kind: 'team'; teamId: string; prefer?: string | null } | { kind: 'agent'; agentId: string }

/** Whose a path is: a pool user's (its home), a share's, or nobody's. */
export type PathOwner = { kind: 'user'; user: string } | ShareOwner

function under(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The pool user `agentId` runs as. Throws when it has none. */
export function poolUserForAgent(agentId: string): PoolUser {
  const pool = activeAgentPool()
  const name = poolUserNameFor(agentId)
  const user = pool.user(name)
  if (!user) {
    throw new AgentPoolShortError(
      `This agent's user ${name} is no longer in CLAWBOO_AGENT_USERS, so the agent cannot run. Add it back, or delete the agent.`,
    )
  }
  return user
}

/** The home of the pool user whose home holds `p`, or null. */
export function poolHomeHolding(p: string): string | null {
  const abs = path.resolve(p)
  for (const u of activeAgentPool().users) {
    const home = path.resolve(u.home)
    if (under(abs, home)) return home
  }
  return null
}

/** The home of the user `agentId` runs as. */
export function agentUserHome(agentId: string): string {
  return path.resolve(poolUserForAgent(agentId).home)
}

/** The host of `agentId`'s own user, with its team's group. */
export function hostForAgent(agentId: string): Promise<AgentHostClient> {
  try {
    const user = poolUserForAgent(agentId)
    return activeAgentPool().hostFor(user.name, shareGroupNameFor(agentId))
  } catch (err) {
    return Promise.reject(err)
  }
}

/**
 * The host of pool user `userName`, with the group its agent's host runs with
 * (so a file in its own home does not restart the host with another group).
 */
function hostForUser(userName: string, agentId: string | null): Promise<AgentHostClient> {
  try {
    const group = agentId ? shareGroupNameFor(agentId) : null
    return activeAgentPool().hostFor(userName, group)
  } catch (err) {
    return Promise.reject(err)
  }
}

/** The agent who acts for a share: the agent itself, or the team's oldest
 *  agent that has a user (`prefer` first when it is on the team). */
export function shareActor(owner: ShareOwner, prefer?: string | null): string {
  if (owner.kind === 'agent') return owner.agentId
  // Members whose user is still in the pool: one taken out of the setting
  // cannot run, and must not hold up the rest of its team.
  const pool = activeAgentPool()
  const members = teamMembersWithUsers(owner.teamId).filter((m) => pool.user(m.userName) !== null)
  const want = prefer ?? actingAgent() ?? owner.prefer ?? null
  const chosen = (want ? members.find((m) => m.agentId === want) : undefined) ?? members[0]
  if (!chosen) {
    throw new AgentPoolShortError(
      'No agent of this team has an agent user yet, so nothing can reach its folders.',
    )
  }
  return chosen.agentId
}

/** The share a work folder segment names (`teams/<segment>`, `mirrors/<segment>`). */
export function shareOfSegment(
  segment: string,
  lookupAgent: (seg: string) => string | null,
  lookupTeam: (seg: string) => string | null,
): ShareOwner | null {
  if (segment.startsWith(AGENT_SHARE_PREFIX)) {
    const agentId = lookupAgent(segment.slice(AGENT_SHARE_PREFIX.length))
    return agentId ? { kind: 'agent', agentId } : null
  }
  const teamId = lookupTeam(segment)
  return teamId ? { kind: 'team', teamId } : null
}

export interface PathRouteDeps {
  users: readonly PoolUser[]
  workDir: string
  /** The install's own folder under `reviews/`. */
  reviewsSegment: string | null
  agentForSegment(seg: string): string | null
  teamForSegment(seg: string): string | null
  taskOwners(taskId: string): { teamId: string | null; assignee: string | null } | null
}

/**
 * Whose `p` is, read from the path alone (and the task a checkout is for):
 * - `<pool home>/...`: that user;
 * - `<work>/teams/<share>/...`, `<work>/mirrors/<share>/...`,
 *   `<work>/team-history/<share>.git/...`,
 *   `<work>/reviews/<install>/<share>/...`: that share;
 * - `<work>/worktrees/<repo>/<task>/...`: the task's team, or with no team its
 *   assignee.
 * Null for anything else, the work folder's own structure included.
 */
export function ownerOfPath(p: string, deps: PathRouteDeps): PathOwner | null {
  const abs = path.resolve(p)
  for (const u of deps.users) {
    if (under(abs, path.resolve(u.home))) return { kind: 'user', user: u.name }
  }
  const work = path.resolve(deps.workDir)
  if (!under(abs, work)) return null
  const parts = path.relative(work, abs).split(path.sep).filter(Boolean)
  const share = (seg: string | undefined): ShareOwner | null =>
    seg ? shareOfSegment(seg, deps.agentForSegment, deps.teamForSegment) : null
  switch (parts[0]) {
    case 'teams':
    case 'mirrors':
      return parts.length >= 2 ? share(parts[1]) : null
    case 'team-history':
      return parts.length >= 2 ? share(parts[1]!.replace(/\.git$/, '')) : null
    case 'reviews':
      if (!deps.reviewsSegment || parts[1] !== deps.reviewsSegment || parts.length < 3) return null
      return share(parts[2]!.replace(/^team-/, ''))
    case 'worktrees': {
      if (parts.length < 3) return null
      const owners = deps.taskOwners(parts[2]!)
      if (!owners) return null
      if (owners.teamId) return { kind: 'team', teamId: owners.teamId, prefer: owners.assignee }
      return owners.assignee ? { kind: 'agent', agentId: owners.assignee } : null
    }
    default:
      return null
  }
}

let routeDeps: (() => PathRouteDeps) | null = null

/** Set at boot: how paths are read (the work folder, the pool, the lookups). */
export function setPathRouteDeps(next: (() => PathRouteDeps) | null): void {
  routeDeps = next
}

/** Whose `p` is, with the lookups set at boot; null before boot or for nobody's. */
export function ownerOfPathNow(p: string): PathOwner | null {
  return routeDeps ? ownerOfPath(p, routeDeps()) : null
}

/** The agent who acts on `p`, or null when no agent owns it. */
export function actorForPath(p: string, prefer?: string | null): string | null {
  if (!routeDeps) return null
  const owner = ownerOfPath(p, routeDeps())
  if (!owner) return null
  if (owner.kind === 'user') return agentOfPoolUser(owner.user)
  return shareActor(owner, prefer)
}

/** The host that may act on `p`. Rejects when no agent owns it. */
export function hostForPath(p: string, prefer?: string | null): Promise<AgentHostClient> {
  try {
    if (!routeDeps) throw new AgentPoolShortError('agent isolation has not started')
    const owner = ownerOfPath(p, routeDeps())
    if (!owner) {
      throw Object.assign(new Error(`${p} belongs to no agent, so no agent host may touch it`), {
        code: 'EACCES',
      })
    }
    if (owner.kind === 'user') return hostForUser(owner.user, agentOfPoolUser(owner.user))
    return hostForAgent(shareActor(owner, prefer))
  } catch (err) {
    return Promise.reject(err)
  }
}

/** Whether `agentId` already has a user (no pass is run). */
export function hasPoolUser(agentId: string): boolean {
  return peekPoolUserNameFor(agentId) !== null
}

export { taskOwners }
