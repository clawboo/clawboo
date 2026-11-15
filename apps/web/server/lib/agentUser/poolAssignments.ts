// Which pool user each agent runs as, and which group each team shares its
// folders through (CLAWBOO_AGENT_USERS, CLAWBOO_AGENT_GROUPS).
//
// The records live in the database (`agent_os_users`, `team_os_groups`; see
// `@clawboo/db`'s agentOsUsers.ts). A pass hands free users to live agents and
// free groups to live teams, oldest first; it runs at boot, whenever an agent
// with no user needs one, and after a deleted agent's user is wiped. Lookups
// are synchronous (the database is), so the path helpers that need an agent's
// home stay synchronous too.

import {
  agentOsUserOf,
  agentOsUsers,
  agents,
  assignAgentOsUsers,
  assignTeamOsGroups,
  syncAgentOsUsers,
  syncTeamOsGroups,
  teamOsGroupOf,
  teams,
  tasks,
  type OsPoolAssignment,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getDb } from '../db'
import type { PoolGroup, PoolUser } from './pool'

/**
 * Runtimes whose agents run inside the runtime's own long-lived service (the
 * OpenClaw Gateway) rather than as processes of their own, so they take no
 * user from the pool.
 */
export const NO_POOL_USER_RUNTIMES: readonly string[] = ['openclaw']

/** A name that is no agent (a reviewer's `critic`, an agent deleted meanwhile). */
export class UnknownAgentError extends Error {
  readonly code = 'ENOAGENT'
  constructor(agentId: string) {
    super(`There is no agent ${agentId}.`)
    this.name = 'UnknownAgentError'
  }
}

/** An agent that has no pool user, or a team that has no group, and why. */
export class AgentPoolShortError extends Error {
  readonly code = 'ENOAGENTUSER'
  constructor(message: string) {
    super(message)
    this.name = 'AgentPoolShortError'
  }
}

/** Write the pool as the setting resolved it into the records. */
export function syncPoolRecords(users: readonly PoolUser[], groups: readonly PoolGroup[]): void {
  const db = getDb()
  syncAgentOsUsers(
    db,
    users.map((u) => ({ name: u.name, id: u.uid, order: u.order })),
  )
  syncTeamOsGroups(
    db,
    groups.map((g) => ({ name: g.name, id: g.gid, order: g.order })),
  )
}

export interface PoolPass {
  users: OsPoolAssignment
  groups: OsPoolAssignment
}

/** Hand out free users and groups, oldest owner first. */
export function runAssignmentPass(): PoolPass {
  const db = getDb()
  return {
    users: assignAgentOsUsers(db, { excludeRuntimes: NO_POOL_USER_RUNTIMES }),
    groups: assignTeamOsGroups(db),
  }
}

function agentRow(
  agentId: string,
): { name: string; teamId: string | null; runtime: string } | null {
  return (
    getDb()
      .select({ name: agents.name, teamId: agents.teamId, runtime: agents.runtime })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get() ?? null
  )
}

/** The pool user `agentId` runs as. Hands one out when it has none yet; throws
 *  `AgentPoolShortError` when none is free. */
export function poolUserNameFor(agentId: string): string {
  const db = getDb()
  let row = agentOsUserOf(db, agentId)
  if (!row) {
    runAssignmentPass()
    row = agentOsUserOf(db, agentId)
  }
  if (row) return row.userName
  const agent = agentRow(agentId)
  if (!agent) throw new UnknownAgentError(agentId)
  if (NO_POOL_USER_RUNTIMES.includes(agent.runtime)) {
    throw new AgentPoolShortError(
      `${agent.name} runs in the ${agent.runtime} service, which does not run as a pooled agent user yet.`,
    )
  }
  throw new AgentPoolShortError(
    `${agent.name} has no agent user: every user in CLAWBOO_AGENT_USERS belongs to another agent. Add users to the pool, or delete an agent you no longer need; the oldest waiting agent gets the next one.`,
  )
}

/** The pool user of `agentId`, or null when it has none (no pass is run). */
export function peekPoolUserNameFor(agentId: string): string | null {
  return agentOsUserOf(getDb(), agentId)?.userName ?? null
}

/** The agent pool user `userName` belongs to, or null (free, or being wiped). */
export function agentOfPoolUser(userName: string): string | null {
  const row = getDb()
    .select({ agentId: agentOsUsers.agentId, state: agentOsUsers.state })
    .from(agentOsUsers)
    .where(eq(agentOsUsers.userName, userName))
    .get()
  return row && row.state === 'assigned' ? row.agentId : null
}

/** The team `agentId` is on, or null. */
export function agentTeamOf(agentId: string): string | null {
  return agentRow(agentId)?.teamId ?? null
}

/** The group team `teamId` shares its folders through. Throws when it has none. */
export function teamGroupNameFor(teamId: string): string {
  const db = getDb()
  let row = teamOsGroupOf(db, teamId)
  if (!row) {
    runAssignmentPass()
    row = teamOsGroupOf(db, teamId)
  }
  if (row) return row.groupName
  const team = db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).get()
  throw new AgentPoolShortError(
    `Team ${team?.name ?? teamId} has no group for its folders: every group in CLAWBOO_AGENT_GROUPS belongs to another team, or none are set. Add groups to the pool; the oldest waiting team gets the next one.`,
  )
}

/** The group an agent's host runs with: its team's, or null (its own) with no team. */
export function shareGroupNameFor(agentId: string): string | null {
  const teamId = agentTeamOf(agentId)
  return teamId ? teamGroupNameFor(teamId) : null
}

/** The live agents of a team that have a pool user, oldest first. */
export function teamMembersWithUsers(teamId: string): { agentId: string; userName: string }[] {
  const db = getDb()
  const rows = db
    .select({ id: agents.id, createdAt: agents.createdAt })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .all()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const out: { agentId: string; userName: string }[] = []
  for (const r of rows) {
    const u = agentOsUserOf(db, r.id)
    if (u) out.push({ agentId: r.id, userName: u.userName })
  }
  return out
}

/** A task's team and assignee, for the folders it owns. */
export function taskOwners(
  taskId: string,
): { teamId: string | null; assignee: string | null } | null {
  const row = getDb()
    .select({ teamId: tasks.teamId, assignee: tasks.assigneeAgentId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()
  return row ? { teamId: row.teamId ?? null, assignee: row.assignee ?? null } : null
}
