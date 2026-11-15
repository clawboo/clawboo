// The agent hosts of a pool (CLAWBOO_AGENT_USERS): one per agent user.
//
// - Started on first need, through sudo, as that user and, when the agent is
//   on a team, with the team's group (`sudo -g`), so the host and everything it
//   starts reach that team's folders and no other's.
// - Checked at every start: the kernel's uid, gid, home and groups must be the
//   ones the account database gave the pool, and the groups nothing more than
//   the user's own and its team's.
// - Watched on its own. A host that stops answering for 5 seconds costs only
//   its own user's processes (`kill -1` as that user), and the next need starts
//   it again, after a pause that grows with each failure. One agent killing its
//   own host stops nobody else.
// - Closed, with its user's processes, after a while with nothing running, so
//   an idle agent holds no process.
//
// Everything that starts or stops a process is passed in, so the registry is
// tested with fake hosts.

// POSIX path rules on every host: a user per agent runs on Linux only, so its
// paths must not change meaning under another platform's rules (in tests too).
import { posix as path } from 'node:path'

import type { AgentHostClient } from './client'
import type { HelloFrame } from './protocol'
import type { PoolGroup, PoolUser } from './pool'

type Log = {
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}

export interface PoolHostDeps {
  users: readonly PoolUser[]
  groups: readonly PoolGroup[]
  /** The server's own primary group. */
  serverGid: number
  /** Start a host as `user`, with `group` as its group when set; resolves once
   *  it said hello. */
  open(user: PoolUser, group: PoolGroup | null): Promise<AgentHostClient>
  /** Stop every process of `user` without its host (`kill -1` as that user,
   *  three times). Resolves once done; a new host for that user starts only
   *  after it, so the stop never reaches the new one. */
  reap(user: PoolUser): Promise<void>
  /** The same, blocking, for the exit path. */
  reapSync(user: PoolUser): void
  log: Log
  /** How long a host with nothing to do stays up. Default 10 minutes. */
  idleMs?: number
  /** Ping cadence and silence limit. Default 2 s and 5 s. */
  watch?: { everyMs: number; deadMs: number }
  now?: () => number
}

/** A pooled agent's host is not available, and why. */
export class PoolHostError extends Error {
  readonly code: string
  constructor(message: string, code = 'EAGENTHOST') {
    super(message)
    this.name = 'PoolHostError'
    this.code = code
  }
}

interface Entry {
  user: PoolUser
  group: PoolGroup | null
  client: AgentHostClient | null
  hello: HelloFrame | null
  starting: Promise<AgentHostClient> | null
  stopWatch: (() => void) | null
  lastUsed: number
  failures: number
  notBefore: number
  lastError: string | null
  /** A stop of this user's processes still running. */
  reaping: Promise<void> | null
  /** Why the last stop of this user's processes failed, or null. */
  reapFailed: string | null
  /** The groups processes that could not be stopped may hold (null: its own),
   *  kept until a stop succeeds. */
  reapFailedGroups: Set<string | null>
  /** Bumped by every stop: a start begun before it publishes nothing. */
  generation: number
}

/** The longest pause between start attempts after failures. */
const MAX_BACKOFF_MS = 30_000

/**
 * Why `hello` is not the host `user` should be, or null. The groups must be
 * the user's own and, with a team, the team's: no other pool member's, not the
 * server's, nothing else at all.
 */
export function poolHelloProblem(
  user: PoolUser,
  group: PoolGroup | null,
  hello: HelloFrame,
  serverGid: number,
): string | null {
  if (hello.uid !== user.uid) {
    return `the host for ${user.name} runs as uid ${hello.uid}, not ${user.uid}`
  }
  const wantGid = group ? group.gid : user.gid
  if (hello.gid !== wantGid) {
    return `the host for ${user.name} runs with gid ${hello.gid}, not ${wantGid}${group ? ` (${group.name})` : ''}`
  }
  if (path.resolve(hello.home) !== path.resolve(user.home)) {
    return `the host for ${user.name} has the home ${hello.home}, not ${user.home}`
  }
  const allowed = new Set<number>([user.gid, ...(group ? [group.gid] : [])])
  const extra = hello.groups.filter((g) => !allowed.has(g))
  if (extra.length > 0) {
    const why = extra.includes(serverGid) ? " (the server's group)" : ''
    return `${user.name} also holds the group${extra.length === 1 ? '' : 's'} ${extra.join(', ')}${why}. A pooled agent user must hold no group but its own: remove it from the others (\`gpasswd -d ${user.name} <group>\`).`
  }
  if (!hello.groups.includes(user.gid)) {
    return `the host for ${user.name} does not hold its own group ${user.gid}`
  }
  return null
}

export class AgentPool {
  private readonly entries = new Map<string, Entry>()
  private readonly byName: Map<string, PoolUser>
  private readonly groupsByName: Map<string, PoolGroup>
  private idleTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly deps: PoolHostDeps) {
    this.byName = new Map(deps.users.map((u) => [u.name, u]))
    this.groupsByName = new Map(deps.groups.map((g) => [g.name, g]))
  }

  get users(): readonly PoolUser[] {
    return this.deps.users
  }

  get groups(): readonly PoolGroup[] {
    return this.deps.groups
  }

  user(name: string): PoolUser | null {
    return this.byName.get(name) ?? null
  }

  group(name: string): PoolGroup | null {
    return this.groupsByName.get(name) ?? null
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Close idle hosts every minute, then run `alsoEachMinute` (a reconcile). */
  startIdleSweep(alsoEachMinute?: () => void): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      this.sweepIdle()
      alsoEachMinute?.()
    }, 60_000)
    this.idleTimer.unref?.()
  }

  /** The host for `userName` running with `groupName` (null: its own group),
   *  started when it is not running. */
  async hostFor(userName: string, groupName: string | null): Promise<AgentHostClient> {
    if (this.closed) throw new PoolHostError('agent isolation is stopping')
    const user = this.byName.get(userName)
    if (!user) {
      throw new PoolHostError(
        `${userName} is not in CLAWBOO_AGENT_USERS any more, so its agent cannot run. Add it back, or delete the agent.`,
        'ENOUSER',
      )
    }
    const group = groupName === null ? null : (this.groupsByName.get(groupName) ?? null)
    if (groupName !== null && !group) {
      throw new PoolHostError(
        `${groupName} is not in CLAWBOO_AGENT_GROUPS any more, so its team's agents cannot run. Add it back.`,
        'ENOGROUP',
      )
    }
    const e = this.entryFor(user, group)
    e.lastUsed = this.now()
    if ((e.group?.name ?? null) !== groupName && e.starting) {
      // Let a start for the old team finish (or fail) before it is undone.
      await e.starting.catch(() => undefined)
    }
    if ((e.group?.name ?? null) !== groupName) {
      // The agent moved team: its host and everything it runs held the old
      // team's group, so they stop before it reaches the new one.
      this.deps.log.info(
        { user: userName, from: e.group?.name ?? null, to: groupName },
        "Agent isolation: an agent's team changed; restarting its host",
      )
      this.stopEntry(e, 'its team changed')
      e.group = group
      e.failures = 0
      e.notBefore = 0
    }
    if (e.client && !e.client.closed) return e.client
    if (e.starting) return e.starting
    if (this.now() < e.notBefore) {
      throw new PoolHostError(
        `the agent host for ${userName} failed to start (${e.lastError ?? 'unknown'}); trying again shortly`,
      )
    }
    const entry = e
    const starting = this.start(entry)
    entry.starting = starting
    try {
      return await starting
    } finally {
      if (entry.starting === starting) entry.starting = null
    }
  }

  private entryFor(user: PoolUser, group: PoolGroup | null): Entry {
    let e = this.entries.get(user.name)
    if (!e) {
      e = {
        user,
        group,
        client: null,
        hello: null,
        starting: null,
        stopWatch: null,
        lastUsed: this.now(),
        failures: 0,
        notBefore: 0,
        lastError: null,
        reaping: null,
        reapFailed: null,
        reapFailedGroups: new Set(),
        generation: 0,
      }
      this.entries.set(user.name, e)
    }
    return e
  }

  private async start(e: Entry): Promise<AgentHostClient> {
    const group = e.group
    const generation = e.generation
    // A stop of this user's processes still under way would reach the new host.
    while (e.reaping) await e.reaping
    if (e.reapFailed) {
      // Its old processes may still run (with an old team's group, say): try
      // once more, and start nothing while they might.
      this.reapEntry(e)
      while (e.reaping) await e.reaping
      if (e.reapFailed) {
        const why = e.reapFailed
        this.failed(e, why)
        throw new PoolHostError(
          `the processes of ${e.user.name} could not be stopped (${why}), so no new host starts for it`,
        )
      }
    }
    let client: AgentHostClient
    try {
      client = await this.deps.open(e.user, group)
    } catch (err) {
      this.failed(e, err instanceof Error ? err.message : String(err))
      throw new PoolHostError(
        `could not start the agent host for ${e.user.name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const hello = client.hello
    const problem = hello
      ? poolHelloProblem(e.user, group, hello, this.deps.serverGid)
      : 'it sent no hello'
    if (problem) {
      client.close('identity refused')
      this.reapEntry(e)
      this.failed(e, problem)
      this.deps.log.error({ user: e.user.name, problem }, 'Agent isolation: refused an agent host')
      throw new PoolHostError(`refused the agent host for ${e.user.name}: ${problem}`, 'EIDENTITY')
    }
    if (this.closed) {
      client.close('agent isolation is stopping')
      this.deps.reapSync(e.user)
      throw new PoolHostError('agent isolation is stopping')
    }
    if (e.group !== group) {
      client.close('its team changed')
      this.reapEntry(e)
      throw new PoolHostError(`the team of ${e.user.name}'s agent changed while its host started`)
    }
    if (e.generation !== generation) {
      // Stopped while it started (its agent deleted, a wipe begun): the late
      // host and anything it started go too.
      client.close('stopped while it started')
      this.reapEntry(e)
      throw new PoolHostError(`${e.user.name} was stopped while its host started`)
    }
    e.client = client
    e.hello = hello
    e.failures = 0
    e.lastError = null
    e.stopWatch = client.watch((reason) => this.onDead(e, client, reason), this.deps.watch)
    return client
  }

  private failed(e: Entry, reason: string): void {
    e.failures += 1
    e.lastError = reason
    e.notBefore = this.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (e.failures - 1))
  }

  private onDead(e: Entry, client: AgentHostClient, reason: string): void {
    if (e.client !== client) return
    this.deps.log.error(
      { user: e.user.name, reason },
      "Agent isolation: an agent's host stopped answering; stopping that agent's processes",
    )
    this.stopEntry(e, reason)
    this.failed(e, reason)
  }

  /** Close an entry's host and stop every process of its user. */
  private stopEntry(e: Entry, reason: string): void {
    e.generation += 1
    e.stopWatch?.()
    e.stopWatch = null
    const client = e.client
    e.client = null
    e.hello = null
    client?.close(reason)
    this.reapEntry(e)
  }

  private reapEntry(e: Entry): void {
    const heldGroup = e.group?.name ?? null
    const prev = e.reaping ?? Promise.resolve()
    const p: Promise<void> = prev
      .then(() => this.deps.reap(e.user))
      .then(
        () => {
          e.reapFailed = null
          e.reapFailedGroups.clear()
        },
        (err: unknown) => {
          e.reapFailed = err instanceof Error ? err.message : String(err)
          e.reapFailedGroups.add(heldGroup)
          this.deps.log.warn(
            { user: e.user.name, err: e.reapFailed },
            "Agent isolation: could not stop an agent user's processes",
          )
        },
      )
      .finally(() => {
        if (e.reaping === p) e.reaping = null
      })
    e.reaping = p
  }

  /** The running host of `userName`, with the group it runs with, or null. */
  running(
    userName: string,
  ): { client: AgentHostClient; hello: HelloFrame; group: PoolGroup | null } | null {
    const e = this.entries.get(userName)
    if (!e?.client || e.client.closed || !e.hello) return null
    return { client: e.client, hello: e.hello, group: e.group }
  }

  /** Every running host. */
  runningHosts(): { user: PoolUser; hello: HelloFrame; group: PoolGroup | null }[] {
    const out: { user: PoolUser; hello: HelloFrame; group: PoolGroup | null }[] = []
    for (const e of this.entries.values()) {
      if (e.client && !e.client.closed && e.hello)
        out.push({ user: e.user, hello: e.hello, group: e.group })
    }
    return out
  }

  /** Stop `userName`'s host and every process of that user. */
  close(userName: string, reason: string): void {
    const user = this.byName.get(userName)
    if (!user) return
    const e = this.entries.get(userName) ?? this.entryFor(user, null)
    this.stopEntry(e, reason)
  }

  /**
   * Whether processes that could not be stopped may still hold `groupName`:
   * a team's group is never handed out again while they might. Each check
   * first tries those stops once more.
   */
  async groupMayBeHeld(groupName: string): Promise<boolean> {
    for (const e of this.entries.values()) {
      if (!e.reapFailed || !e.reapFailedGroups.has(groupName)) continue
      this.reapEntry(e)
      while (e.reaping) await e.reaping
      if (e.reapFailed) return true
    }
    return false
  }

  /** Resolves once no stop of `userName`'s processes is under way. */
  async settled(userName: string): Promise<void> {
    const e = this.entries.get(userName)
    while (e?.reaping) await e.reaping
  }

  /** Close the hosts that have had nothing to do for `idleMs`. */
  sweepIdle(): void {
    const idleMs = this.deps.idleMs ?? 10 * 60_000
    const now = this.now()
    for (const e of this.entries.values()) {
      if (!e.client || e.client.closed || e.starting) continue
      if (e.client.busy > 0) {
        e.lastUsed = now
        continue
      }
      if (now - e.lastUsed < idleMs) continue
      this.deps.log.info({ user: e.user.name }, 'Agent isolation: closing an idle agent host')
      this.stopEntry(e, 'idle')
    }
  }

  /** Stop every host and every process of every pool user. */
  closeAll(reason: string): void {
    this.closed = true
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    for (const e of this.entries.values()) {
      e.stopWatch?.()
      e.stopWatch = null
      e.client?.close(reason)
      e.client = null
      e.hello = null
    }
    for (const u of this.deps.users) this.deps.reapSync(u)
  }
}
