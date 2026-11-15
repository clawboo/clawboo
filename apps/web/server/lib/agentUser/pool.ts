// The pool of agent users (CLAWBOO_AGENT_USERS) and team groups
// (CLAWBOO_AGENT_GROUPS), looked up in the account database and checked.
//
// Each agent runs as a user of its own from the pool, so the pool is only a
// wall if its members share nothing: no uid, no primary group, no home, no
// membership in each other's groups or the server's. Each team gets a group,
// which its agents' hosts run with (`sudo -g`) and nothing else holds: an agent
// that were a standing member of a team group would reach that team's folder
// whatever team it is on. The server user is a member of every one of them, so
// it can make the team folders (group = the team's) and the folders of agents
// with no team (group = the agent's own).
//
// Everything that reads the machine is passed in, so each refusal is tested
// with a fake account database.

import path from 'node:path'

import type { PoolSpec } from './config'

export interface PoolUser {
  name: string
  uid: number
  /** Its primary group: its own, which nobody else in the pool has. */
  gid: number
  home: string
  /** Its place in the pool: users are handed out in this order. */
  order: number
}

export interface PoolGroup {
  name: string
  gid: number
  order: number
}

export interface AccountRecord {
  name: string
  uid: number
  gid: number
  home: string
}

export interface GroupRecord {
  name: string
  gid: number
  /** The names listed as members (not those who have it as primary group). */
  members: string[]
}

export interface AccountDb {
  userByName(name: string): AccountRecord | null
  userByUid(uid: number): AccountRecord | null
  groupByName(name: string): GroupRecord | null
  groupByGid(gid: number): GroupRecord | null
}

export interface ResolvedPool {
  users: PoolUser[]
  groups: PoolGroup[]
  /** Why the pool cannot be used, one line each; empty when it can. */
  problems: string[]
}

export interface PoolContext {
  serverUid: number
  serverGid: number
  serverUser: string
  serverHome: string
  dataDir: string
  workDir: string | null
  /** The groups this server process holds now (`process.getgroups()`). */
  serverGroups: number[]
}

/** The names, or the ids of the range, in order. */
function poolKeys(spec: PoolSpec): (string | number)[] {
  if (spec.kind === 'names') return spec.names
  return Array.from({ length: spec.hi - spec.lo + 1 }, (_, i) => spec.lo + i)
}

function under(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Every path of `a` and `b` that is the same as, inside or around the other. */
function overlaps(a: string, b: string): boolean {
  return under(a, b) || under(b, a)
}

/**
 * Look the pool up and check it. Returns every problem found, not only the
 * first, so an operator fixes the setup in one pass.
 */
export function resolvePool(
  spec: { users: PoolSpec; groups: PoolSpec | null },
  db: AccountDb,
  ctx: PoolContext,
): ResolvedPool {
  const problems: string[] = []
  const users: PoolUser[] = []
  const groups: PoolGroup[] = []

  for (const key of poolKeys(spec.users)) {
    const rec = typeof key === 'string' ? db.userByName(key) : db.userByUid(key)
    if (!rec) {
      problems.push(
        typeof key === 'string'
          ? `${key}: no such user. Create it with the commands from \`clawboo agent-user plan\`.`
          : `uid ${key}: no user has it. Every id in CLAWBOO_AGENT_USERS must be a user.`,
      )
      continue
    }
    users.push({ ...rec, order: users.length })
  }

  const groupRecords: GroupRecord[] = []
  for (const key of spec.groups ? poolKeys(spec.groups) : []) {
    const rec = typeof key === 'string' ? db.groupByName(key) : db.groupByGid(key)
    if (!rec) {
      problems.push(
        typeof key === 'string'
          ? `${key}: no such group. Create it with the commands from \`clawboo agent-user plan\`.`
          : `gid ${key}: no group has it. Every id in CLAWBOO_AGENT_GROUPS must be a group.`,
      )
      continue
    }
    groupRecords.push(rec)
    groups.push({ name: rec.name, gid: rec.gid, order: groups.length })
  }

  const poolNames = new Set(users.map((u) => u.name))
  const seenUid = new Map<number, string>()
  const seenGid = new Map<number, string>()
  const seenHome = new Map<string, string>()
  for (const u of users) {
    if (u.uid === 0) problems.push(`${u.name} is root. Agents need unprivileged users.`)
    if (u.uid === ctx.serverUid) {
      problems.push(`${u.name} is the user Clawboo runs as. Agents need users of their own.`)
    }
    const dupUid = seenUid.get(u.uid)
    if (dupUid) problems.push(`${u.name} and ${dupUid} have the same uid ${u.uid}.`)
    seenUid.set(u.uid, u.name)

    if (u.gid === 0 || u.gid === ctx.serverGid) {
      problems.push(
        `${u.name}'s primary group (gid ${u.gid}) is ${u.gid === 0 ? 'root' : "the server's"}. Give it a group of its own.`,
      )
    }
    const dupGid = seenGid.get(u.gid)
    if (dupGid) {
      problems.push(
        `${u.name} and ${dupGid} share the primary group gid ${u.gid}. Each agent user needs a group of its own.`,
      )
    }
    seenGid.set(u.gid, u.name)
    const own = db.groupByGid(u.gid)
    const strangers = (own?.members ?? []).filter((m) => m !== ctx.serverUser)
    if (strangers.length > 0) {
      problems.push(
        `${u.name}'s own group ${own?.name ?? u.gid} also holds ${strangers.join(', ')}. Only ${ctx.serverUser} may be in it.`,
      )
    }

    if (!path.isAbsolute(u.home) || path.resolve(u.home) === '/') {
      problems.push(`${u.name}'s home ${JSON.stringify(u.home)} is not a folder of its own.`)
      continue
    }
    const home = path.resolve(u.home)
    if (overlaps(home, ctx.dataDir)) {
      problems.push(`${u.name}'s home ${home} and Clawboo's data folder ${ctx.dataDir} overlap.`)
    }
    if (overlaps(home, ctx.serverHome)) {
      problems.push(
        `${u.name}'s home ${home} and ${ctx.serverUser}'s home ${ctx.serverHome} overlap.`,
      )
    }
    if (ctx.workDir && overlaps(home, ctx.workDir)) {
      problems.push(`${u.name}'s home ${home} and the work folder ${ctx.workDir} overlap.`)
    }
    for (const [other, otherName] of seenHome) {
      if (overlaps(home, other)) {
        problems.push(`${u.name}'s home ${home} and ${otherName}'s home ${other} overlap.`)
      }
    }
    seenHome.set(home, u.name)
  }

  const seenTeamGid = new Map<number, string>()
  for (const g of groupRecords) {
    if (g.gid === 0 || g.gid === ctx.serverGid) {
      problems.push(`The team group ${g.name} is ${g.gid === 0 ? 'root' : "the server's group"}.`)
    }
    const owner = seenGid.get(g.gid)
    if (owner) problems.push(`The team group ${g.name} is ${owner}'s own group.`)
    const dup = seenTeamGid.get(g.gid)
    if (dup) problems.push(`The team groups ${g.name} and ${dup} have the same gid ${g.gid}.`)
    seenTeamGid.set(g.gid, g.name)
    const members = g.members.filter((m) => m !== ctx.serverUser)
    const agents = members.filter((m) => poolNames.has(m))
    if (agents.length > 0) {
      problems.push(
        `${agents.join(', ')} ${agents.length === 1 ? 'is a member' : 'are members'} of the team group ${g.name}. Agents get a team's group only while they are on that team: remove them (\`gpasswd -d <user> ${g.name}\`).`,
      )
    }
    const others = members.filter((m) => !poolNames.has(m))
    if (others.length > 0) {
      problems.push(
        `The team group ${g.name} also holds ${others.join(', ')}, who would reach that team's files. Only ${ctx.serverUser} may be in it.`,
      )
    }
  }

  // An agent user that is a standing member of another pool user's group would
  // reach that agent's folders.
  for (const u of users) {
    const own = db.groupByGid(u.gid)
    const inIt = (own?.members ?? []).filter((m) => poolNames.has(m) && m !== u.name)
    if (inIt.length > 0) {
      problems.push(
        `${inIt.join(', ')} ${inIt.length === 1 ? 'is' : 'are'} in ${u.name}'s own group.`,
      )
    }
  }

  // The server makes the team folders and the folders of agents with no team,
  // with the team's or the agent's group, so it must hold every one of them.
  const held = new Set(ctx.serverGroups)
  const missing = [
    ...users
      .filter((u) => !held.has(u.gid))
      .map((u) => db.groupByGid(u.gid)?.name ?? String(u.gid)),
    ...groups.filter((g) => !held.has(g.gid)).map((g) => g.name),
  ]
  if (missing.length > 0) {
    problems.push(
      `${ctx.serverUser} is not in ${missing.length === 1 ? 'the group' : 'the groups'} ${missing.join(', ')}. Run \`usermod -aG ${missing.join(',')} ${ctx.serverUser}\` as an administrator, then start Clawboo again from a new login (a running process keeps the groups it started with).`,
    )
  }

  return { users, groups, problems }
}

// ── The account database, read with getent ─────────────────────────────

/** One `getent passwd` line, or null. */
export function parsePasswdLine(line: string): AccountRecord | null {
  const f = line.trim().split(':')
  if (f.length < 7) return null
  const uid = Number(f[2])
  const gid = Number(f[3])
  if (!f[0] || !Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) return null
  return { name: f[0], uid, gid, home: f[5] ?? '' }
}

/** One `getent group` line, or null. */
export function parseGroupLine(line: string): GroupRecord | null {
  const f = line.trim().split(':')
  if (f.length < 4) return null
  const gid = Number(f[2])
  if (!f[0] || !Number.isInteger(gid) || gid < 0) return null
  return {
    name: f[0],
    gid,
    members: (f[3] ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  }
}

/** The account database through `getent`, with `run` returning stdout or null. */
export function getentAccountDb(run: (args: string[]) => string | null): AccountDb {
  const one = <T>(args: string[], parse: (l: string) => T | null): T | null => {
    const out = run(args)
    if (out === null) return null
    const line = out.split('\n').find((l) => l.trim() !== '')
    return line ? parse(line) : null
  }
  return {
    userByName: (name) => one(['passwd', name], parsePasswdLine),
    userByUid: (uid) => one(['passwd', String(uid)], parsePasswdLine),
    groupByName: (name) => one(['group', name], parseGroupLine),
    groupByGid: (gid) => one(['group', String(gid)], parseGroupLine),
  }
}
