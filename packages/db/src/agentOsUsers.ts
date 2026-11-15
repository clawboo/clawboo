// The agent user pool's records: which OS user each agent runs as, and which
// group each team shares its folders through.
//
// - The setting (CLAWBOO_AGENT_USERS, CLAWBOO_AGENT_GROUPS) is synced in at
//   boot. A member the setting no longer names keeps its row, out of the pool:
//   an agent that has it keeps it (and its runs say why they cannot start),
//   and nobody new gets it.
// - Users go to live agents oldest first, groups to live teams oldest first, so
//   when the pool runs short the agents that wait are the newest, and the next
//   user freed or added goes to the oldest of them. A live agent or team keeps
//   what it has for its life; an archived one keeps it too, to come back to.
// - When the agent (team) is gone, its row is 'scrubbing': the server stops its
//   processes and wipes what it left (its folders) before the row is free again.
//
// Each write is one BEGIN IMMEDIATE transaction.

import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'

import type { ClawbooDb } from './db'
import { immediateWrite } from './board/contention'
import { agentOsUsers, agents, teamOsGroups, teams } from './schema'
import type { DbAgentOsUser, DbTeamOsGroup } from './schema'

/** One member of the pool, as the setting resolves it. */
export interface OsPoolMember {
  name: string
  /** uid for a user, gid for a group. */
  id: number
  order: number
}

export interface OsPoolAssignment {
  /** Handed out by this pass: [agent or team id, member name]. */
  assigned: { ownerId: string; name: string }[]
  /** Live owners with no member, oldest first. */
  waiting: string[]
  /** Members whose owner is gone, to wipe before reuse: [member name, former owner]. */
  scrubbing: { name: string; ownerId: string }[]
}

// ── Users ────────────────────────────────────────────────────────────────

/** Bring the user rows in line with the setting. */
export function syncAgentOsUsers(
  db: ClawbooDb,
  members: readonly OsPoolMember[],
  now: number = Date.now(),
): void {
  immediateWrite(db, (tx) => {
    for (const m of members) {
      tx.insert(agentOsUsers)
        .values({ userName: m.name, uid: m.id, poolOrder: m.order, inPool: 1, updatedAt: now })
        .onConflictDoUpdate({
          target: agentOsUsers.userName,
          set: { uid: m.id, poolOrder: m.order, inPool: 1, updatedAt: now },
        })
        .run()
    }
    const names = members.map((m) => m.name)
    tx.update(agentOsUsers)
      .set({ inPool: 0, updatedAt: now })
      .where(
        names.length > 0
          ? and(eq(agentOsUsers.inPool, 1), notInArray(agentOsUsers.userName, names))
          : eq(agentOsUsers.inPool, 1),
      )
      .run()
  })
}

/**
 * Hand free users to the live agents that have none, oldest first, and mark
 * the users of agents that are gone as 'scrubbing'. `excludeRuntimes`: agents
 * of these runtimes run inside a runtime's own service and get no user.
 */
export function assignAgentOsUsers(
  db: ClawbooDb,
  opts: { excludeRuntimes?: readonly string[]; now?: number } = {},
): OsPoolAssignment {
  const now = opts.now ?? Date.now()
  const exclude = [...(opts.excludeRuntimes ?? [])]
  return immediateWrite(db, (tx) => {
    // Users of agents that no longer exist (an archived agent still does).
    tx.update(agentOsUsers)
      .set({ state: 'scrubbing', updatedAt: now })
      .where(
        and(
          eq(agentOsUsers.state, 'assigned'),
          sql`NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = ${agentOsUsers.agentId})`,
        ),
      )
      .run()
    const scrubbing = tx
      .select({ name: agentOsUsers.userName, ownerId: agentOsUsers.agentId })
      .from(agentOsUsers)
      .where(eq(agentOsUsers.state, 'scrubbing'))
      .orderBy(asc(agentOsUsers.poolOrder), asc(agentOsUsers.userName))
      .all()
      .map((r) => ({ name: r.name, ownerId: r.ownerId ?? '' }))

    const waitingRows = tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.participantKind, 'agent'),
          isNull(agents.archivedAt),
          exclude.length > 0 ? notInArray(agents.runtime, exclude) : undefined,
          sql`NOT EXISTS (SELECT 1 FROM agent_os_users u WHERE u.agent_id = ${agents.id} AND u.state = 'assigned')`,
        ),
      )
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .all()
    const free = tx
      .select({ name: agentOsUsers.userName })
      .from(agentOsUsers)
      .where(and(eq(agentOsUsers.state, 'free'), eq(agentOsUsers.inPool, 1)))
      .orderBy(asc(agentOsUsers.poolOrder), asc(agentOsUsers.userName))
      .all()
    const assigned: OsPoolAssignment['assigned'] = []
    const waiting: string[] = []
    for (const row of waitingRows) {
      const user = free.shift()
      if (!user) {
        waiting.push(row.id)
        continue
      }
      tx.update(agentOsUsers)
        .set({ state: 'assigned', agentId: row.id, assignedAt: now, updatedAt: now })
        .where(and(eq(agentOsUsers.userName, user.name), eq(agentOsUsers.state, 'free')))
        .run()
      assigned.push({ ownerId: row.id, name: user.name })
    }
    return { assigned, waiting, scrubbing }
  })
}

/** The user an agent runs as, or null when it has none (yet). */
export function agentOsUserOf(db: ClawbooDb, agentId: string): DbAgentOsUser | null {
  return (
    db
      .select()
      .from(agentOsUsers)
      .where(and(eq(agentOsUsers.agentId, agentId), eq(agentOsUsers.state, 'assigned')))
      .get() ?? null
  )
}

/** Every user row, in pool order. */
export function listAgentOsUsers(db: ClawbooDb): DbAgentOsUser[] {
  return db
    .select()
    .from(agentOsUsers)
    .orderBy(asc(agentOsUsers.poolOrder), asc(agentOsUsers.userName))
    .all()
}

/** A scrubbed user is free again. Only from 'scrubbing'; returns whether it was. */
export function finishAgentOsUserScrub(
  db: ClawbooDb,
  userName: string,
  now: number = Date.now(),
): boolean {
  return immediateWrite(db, (tx) => {
    const res = tx
      .update(agentOsUsers)
      .set({ state: 'free', agentId: null, assignedAt: null, updatedAt: now })
      .where(and(eq(agentOsUsers.userName, userName), eq(agentOsUsers.state, 'scrubbing')))
      .run()
    return res.changes > 0
  })
}

// ── Team groups ──────────────────────────────────────────────────────────

/** Bring the group rows in line with the setting. */
export function syncTeamOsGroups(
  db: ClawbooDb,
  members: readonly OsPoolMember[],
  now: number = Date.now(),
): void {
  immediateWrite(db, (tx) => {
    for (const m of members) {
      tx.insert(teamOsGroups)
        .values({ groupName: m.name, gid: m.id, poolOrder: m.order, inPool: 1, updatedAt: now })
        .onConflictDoUpdate({
          target: teamOsGroups.groupName,
          set: { gid: m.id, poolOrder: m.order, inPool: 1, updatedAt: now },
        })
        .run()
    }
    const names = members.map((m) => m.name)
    tx.update(teamOsGroups)
      .set({ inPool: 0, updatedAt: now })
      .where(
        names.length > 0
          ? and(eq(teamOsGroups.inPool, 1), notInArray(teamOsGroups.groupName, names))
          : eq(teamOsGroups.inPool, 1),
      )
      .run()
  })
}

/** Hand free groups to the live teams that have none, oldest first. */
export function assignTeamOsGroups(db: ClawbooDb, opts: { now?: number } = {}): OsPoolAssignment {
  const now = opts.now ?? Date.now()
  return immediateWrite(db, (tx) => {
    tx.update(teamOsGroups)
      .set({ state: 'scrubbing', updatedAt: now })
      .where(
        and(
          eq(teamOsGroups.state, 'assigned'),
          sql`NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = ${teamOsGroups.teamId})`,
        ),
      )
      .run()
    const scrubbing = tx
      .select({ name: teamOsGroups.groupName, ownerId: teamOsGroups.teamId })
      .from(teamOsGroups)
      .where(eq(teamOsGroups.state, 'scrubbing'))
      .orderBy(asc(teamOsGroups.poolOrder), asc(teamOsGroups.groupName))
      .all()
      .map((r) => ({ name: r.name, ownerId: r.ownerId ?? '' }))

    const waitingRows = tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.isArchived, 0),
          sql`NOT EXISTS (SELECT 1 FROM team_os_groups g WHERE g.team_id = ${teams.id} AND g.state = 'assigned')`,
        ),
      )
      .orderBy(asc(teams.createdAt), asc(teams.id))
      .all()
    const free = tx
      .select({ name: teamOsGroups.groupName })
      .from(teamOsGroups)
      .where(and(eq(teamOsGroups.state, 'free'), eq(teamOsGroups.inPool, 1)))
      .orderBy(asc(teamOsGroups.poolOrder), asc(teamOsGroups.groupName))
      .all()
    const assigned: OsPoolAssignment['assigned'] = []
    const waiting: string[] = []
    for (const row of waitingRows) {
      const group = free.shift()
      if (!group) {
        waiting.push(row.id)
        continue
      }
      tx.update(teamOsGroups)
        .set({ state: 'assigned', teamId: row.id, assignedAt: now, updatedAt: now })
        .where(and(eq(teamOsGroups.groupName, group.name), eq(teamOsGroups.state, 'free')))
        .run()
      assigned.push({ ownerId: row.id, name: group.name })
    }
    return { assigned, waiting, scrubbing }
  })
}

/** The group a team shares its folders through, or null. */
export function teamOsGroupOf(db: ClawbooDb, teamId: string): DbTeamOsGroup | null {
  return (
    db
      .select()
      .from(teamOsGroups)
      .where(and(eq(teamOsGroups.teamId, teamId), eq(teamOsGroups.state, 'assigned')))
      .get() ?? null
  )
}

/** Every group row, in pool order. */
export function listTeamOsGroups(db: ClawbooDb): DbTeamOsGroup[] {
  return db
    .select()
    .from(teamOsGroups)
    .orderBy(asc(teamOsGroups.poolOrder), asc(teamOsGroups.groupName))
    .all()
}

/** A scrubbed group is free again. Only from 'scrubbing'. */
export function finishTeamOsGroupScrub(
  db: ClawbooDb,
  groupName: string,
  now: number = Date.now(),
): boolean {
  return immediateWrite(db, (tx) => {
    const res = tx
      .update(teamOsGroups)
      .set({ state: 'free', teamId: null, assignedAt: null, updatedAt: now })
      .where(and(eq(teamOsGroups.groupName, groupName), eq(teamOsGroups.state, 'scrubbing')))
      .run()
    return res.changes > 0
  })
}

/**
 * Take a free user out of circulation for a moment (to remove a deleted team's
 * folders as it): marked 'scrubbing' with no agent, so no pass hands it out
 * meanwhile. Give it back with `finishAgentOsUserScrub`. Null when none is free.
 */
export function borrowFreeAgentOsUser(db: ClawbooDb, now: number = Date.now()): string | null {
  return immediateWrite(db, (tx) => {
    const row = tx
      .select({ name: agentOsUsers.userName })
      .from(agentOsUsers)
      .where(and(eq(agentOsUsers.state, 'free'), eq(agentOsUsers.inPool, 1)))
      .orderBy(asc(agentOsUsers.poolOrder), asc(agentOsUsers.userName))
      .get()
    if (!row) return null
    tx.update(agentOsUsers)
      .set({ state: 'scrubbing', agentId: null, updatedAt: now })
      .where(and(eq(agentOsUsers.userName, row.name), eq(agentOsUsers.state, 'free')))
      .run()
    return row.name
  })
}

/** A user's row, or null. */
export function agentOsUserRow(db: ClawbooDb, userName: string): DbAgentOsUser | null {
  return db.select().from(agentOsUsers).where(eq(agentOsUsers.userName, userName)).get() ?? null
}
