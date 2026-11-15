// A user per agent (CLAWBOO_AGENT_USERS) at boot and at shutdown.
//
// The startup check proves, before any run is accepted, that the pool is a
// wall: every user is separate from the server and from each other (the
// account database, then each user's own host), none can read Clawboo's
// private files or see this process's secrets, none can list another agent
// user's home or signal another's processes, and none can become anyone else.
// Any failure refuses the start, as with one agent user.
//
// Then each agent's host starts on its first need (`poolHosts.ts`), and paths
// and processes are routed to it (`poolRoute.ts`, `poolShares.ts`).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import {
  agentOsUserRow,
  agents,
  borrowFreeAgentOsUser,
  finishAgentOsUserScrub,
  finishTeamOsGroupScrub,
  listAgentOsUsers,
  teams,
} from '@clawboo/db'

import { getDb } from '../db'
import { keepRuntimesDirApartFrom } from '../runtimeFolder'
import { sanitizeAgentId } from '../runtimes/identityHome'
import { setUnavailableAgentBinaries } from '../runtimes/spawner'
import { workDirInUse, reviewsRoot, setWorkLayout } from '../workDir'
import { noNewPrivsPrefix, operatorFiles, protectedFiles, resolveAgentHostScript } from './boot'
import {
  dataDirProblem,
  narrowDataDir,
  runHostChecks,
  unsafeParents,
  type CheckStep,
} from './check'
import { AgentHostClient, startHostViaSwitch } from './client'
import { resolveAgentPoolConfig, type AgentPoolConfig } from './config'
import { getentAccountDb, resolvePool, type AccountDb, type PoolGroup, type PoolUser } from './pool'
import {
  agentOfPoolUser,
  runAssignmentPass,
  shareGroupNameFor,
  syncPoolRecords,
  taskOwners,
  type PoolPass,
} from './poolAssignments'
import { AgentPool, poolHelloProblem } from './poolHosts'
import { setPathRouteDeps } from './poolRoute'
import {
  SHARE_TOPS,
  emptyFolderVia,
  ensureStructural,
  removeEmptiedRoot,
  setShareContext,
  type ShareLayout,
} from './poolShares'
import { AGENT_SHARE_PREFIX } from './poolRoute'
import { peekAgentPool, setActiveAgentPool } from './state'
import {
  currentUserName,
  getentRun,
  killAllAgentProcesses,
  reapPoolUser,
  setShareAcl,
} from './system'

type Log = {
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}

export interface PoolCheckDeps {
  platform: NodeJS.Platform
  serverUid: number
  serverGid: number
  serverUser: string
  serverHome: string
  serverPid: number
  serverGroups: number[]
  accountDb: AccountDb
  accessToken: string | null
  dataDir: string
  workDir: string | null
  protectedFiles: string[]
  operatorFiles: string[]
  secretValues: string[]
  runtimeBinaries: { runtime: string; path: string }[]
  narrowDataDir(dataDir: string, files: string[]): string[]
  unsafeParents(dir: string): string[]
  dataDirProblem(dataDir: string, files: string[]): string | null
  /** The work folder is the server's, 0711, and nobody else can change what holds it. */
  workDirProblem(dir: string): string | null
  /** Whether `setfacl` is there (the share roots' inherited ACL). */
  hasSetfacl(): boolean
  openHost(user: PoolUser, group: PoolGroup | null): Promise<AgentHostClient>
  reapSync(user: PoolUser): void
  /** How many hosts are checked at once. */
  concurrency?: number
}

export interface PoolCheckReport {
  ok: boolean
  steps: CheckStep[]
  users: PoolUser[]
  groups: PoolGroup[]
  unavailableRuntimes: { runtime: string; path: string; reason: string }[]
}

/** The sudoers line a pool needs, users named one by one (sudo takes a team
 *  group with `-g` only when the users are written out, not as an alias). */
export function poolSudoersLines(serverUser: string, users: string[], groups: string[]): string {
  const runAs =
    groups.length > 0 ? `(${users.join(', ')} : ${groups.join(', ')})` : `(${users.join(', ')})`
  return [
    `  # /etc/sudoers.d/clawboo (check it with: sudo visudo -cf /etc/sudoers.d/clawboo)`,
    `  ${serverUser} ALL=${runAs} NOPASSWD: ALL`,
    `  Defaults:${serverUser} !requiretty`,
  ].join('\n')
}

/** The check for a pool. Touches nothing global; the caller publishes the pool. */
export async function runAgentPoolCheck(
  config: AgentPoolConfig,
  deps: PoolCheckDeps,
): Promise<PoolCheckReport> {
  const steps: CheckStep[] = []
  const report: PoolCheckReport = {
    ok: false,
    steps,
    users: [],
    groups: [],
    unavailableRuntimes: [],
  }
  const pass = (step: number, name: string, message: string): void => {
    steps.push({ step, name, level: 'ok', message })
  }
  const fail = (step: number, name: string, message: string): PoolCheckReport => {
    steps.push({ step, name, level: 'fail', message })
    return report
  }

  // 1. Platform. Linux only for now: the proof runs there, and macOS has no
  // no_new_privs and caps role accounts at fifty.
  if (deps.platform !== 'linux') {
    return fail(
      1,
      'platform',
      deps.platform === 'win32'
        ? 'Agent isolation is not supported on Windows. Unset CLAWBOO_AGENT_USERS, or run Clawboo under WSL 2 or in a Linux container.'
        : 'CLAWBOO_AGENT_USERS (a user per agent) runs on Linux for now. On this computer use CLAWBOO_AGENT_USER (one agent user for every agent).',
    )
  }
  pass(1, 'platform', deps.platform)

  // 2. The pool, from the account database.
  if (!deps.workDir) {
    return fail(
      2,
      'work folder',
      "CLAWBOO_AGENT_USERS needs CLAWBOO_WORK_DIR: a folder of the server user's, outside the data folder and every agent user's home (for example /var/lib/clawboo-work).",
    )
  }
  const resolved = resolvePool({ users: config.users, groups: config.groups }, deps.accountDb, {
    serverUid: deps.serverUid,
    serverGid: deps.serverGid,
    serverUser: deps.serverUser,
    serverHome: deps.serverHome,
    dataDir: deps.dataDir,
    workDir: deps.workDir,
    serverGroups: deps.serverGroups,
  })
  if (resolved.problems.length > 0) {
    return fail(2, 'agent users', resolved.problems.join('\n'))
  }
  if (resolved.users.length === 0)
    return fail(2, 'agent users', 'CLAWBOO_AGENT_USERS names nobody.')
  report.users = resolved.users
  report.groups = resolved.groups
  pass(
    2,
    'agent users',
    `${resolved.users.length} user${resolved.users.length === 1 ? '' : 's'}, ${resolved.groups.length} team group${resolved.groups.length === 1 ? '' : 's'}`,
  )

  // 3. An access token.
  if (!deps.accessToken) {
    return fail(
      3,
      'access token',
      "Agent isolation needs an access token. Without one, any program on this computer, the agents included, can use Clawboo's API. Set STUDIO_ACCESS_TOKEN, or leave it unset to use the per-install token.",
    )
  }
  pass(3, 'access token', 'set')

  // 4. The data folder.
  const parents = deps.unsafeParents(deps.dataDir)
  if (parents.length > 0) {
    return fail(
      4,
      'data folder',
      `${parents[0]} can be changed by users other than the one Clawboo runs as, so the data folder inside it (${deps.dataDir}) cannot be protected. Move CLAWBOO_HOME somewhere only this user and root can change.`,
    )
  }
  const narrowed = deps.narrowDataDir(deps.dataDir, deps.protectedFiles)
  const ownership = deps.dataDirProblem(deps.dataDir, deps.protectedFiles)
  if (ownership) return fail(4, 'data folder', ownership)
  pass(4, 'data folder', narrowed.length > 0 ? `narrowed: ${narrowed.join(', ')}` : 'private')

  // 5. The work folder and the tool its shares need.
  const workProblem = deps.workDirProblem(deps.workDir)
  if (workProblem) return fail(5, 'work folder', workProblem)
  if (!deps.hasSetfacl()) {
    return fail(
      5,
      'work folder',
      'setfacl is missing. Team folders are shared through an inherited ACL: install the acl package (`apt-get install acl`, `dnf install acl`) and start Clawboo again.',
    )
  }
  pass(5, 'work folder', deps.workDir)

  // 6. Before any host: anything a pool user still runs belongs to a server
  // that is gone.
  for (const u of resolved.users) deps.reapSync(u)

  // 7 to 9, inside each user's own host. Two hosts stay up throughout, so each
  // user is also shown unable to signal another agent user's process.
  const homes = resolved.users.map((u) => path.resolve(u.home))
  const keep = new Map<string, AgentHostClient>()
  const closeHost = (u: PoolUser, client: AgentHostClient): void => {
    client.close('the startup check is done with it')
    deps.reapSync(u)
  }
  const checkOne = async (u: PoolUser): Promise<string | null> => {
    let client: AgentHostClient
    try {
      client = await deps.openHost(u, null)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      return `Could not start the agent host as ${u.name} with ${config.switch} (${why}). Clawboo needs one ${config.switch} rule, written once by an administrator:\n${poolSudoersLines(
        deps.serverUser,
        resolved.users.map((x) => x.name),
        resolved.groups.map((g) => g.name),
      )}`
    }
    // 6. Identity: the kernel's answer, not the name asked for.
    const problem = client.hello
      ? poolHelloProblem(u, null, client.hello, deps.serverGid)
      : 'it sent no hello'
    if (problem) {
      steps.push({ step: 6, name: 'identity', level: 'fail', message: problem })
      closeHost(u, client)
      return 'failed'
    }
    const refPids = [...keep.entries()]
      .filter(([name]) => name !== u.name)
      .map(([, c]) => c.hello?.pid)
      .filter((p): p is number => typeof p === 'number')
      .slice(0, 1)
    const res = await runHostChecks(client, {
      platform: deps.platform,
      user: u.name,
      serverUser: deps.serverUser,
      serverPid: deps.serverPid,
      serverHome: deps.serverHome,
      dataDir: deps.dataDir,
      protectedFiles: deps.protectedFiles,
      operatorFiles: deps.operatorFiles,
      writable: path.resolve(u.home),
      searchRoot: path.resolve(u.home),
      secretValues: deps.secretValues,
      runtimeBinaries: deps.runtimeBinaries,
      otherAgentHomes: homes.filter((h) => h !== path.resolve(u.home)),
      otherAgentPids: refPids,
    })
    for (const s of res.steps) {
      if (s.level !== 'ok') steps.push({ ...s, message: `${u.name}: ${s.message}` })
    }
    for (const r of res.unavailableRuntimes) {
      if (!report.unavailableRuntimes.some((x) => x.path === r.path))
        report.unavailableRuntimes.push(r)
    }
    if (!res.ok) {
      closeHost(u, client)
      return 'failed'
    }
    if (keep.size < 2) keep.set(u.name, client)
    else closeHost(u, client)
    return null
  }
  // The first two one at a time, so every later one has a process to try.
  const ordered = [...resolved.users]
  let failed: string | null = null
  for (const u of ordered.slice(0, 2)) {
    failed = await checkOne(u)
    if (failed) break
  }
  // The first user checked before any other host was up: try it now.
  if (!failed && keep.size === 2) {
    const [first, second] = [...keep.entries()]
    const firstUser = ordered[0]!
    const sig = await first![1]
      .request({ op: 'canSignal', pids: [second![1].hello?.pid ?? 0] })
      .catch(() => null)
    const r = sig?.results?.[0]
    if (!r || r.ok || r.code !== 'EPERM') {
      failed = `${firstUser.name} can signal a process of ${second![0]}. Agent users must be ordinary, separate users.`
      steps.push({ step: 7, name: 'other agents', level: 'fail', message: failed })
    }
  }
  const rest = ordered.slice(2)
  const width = Math.max(1, deps.concurrency ?? 4)
  for (let i = 0; !failed && i < rest.length; i += width) {
    const results = await Promise.all(rest.slice(i, i + width).map((u) => checkOne(u)))
    failed = results.find((r) => r !== null) ?? null
  }
  for (const [name, client] of keep) {
    const u = resolved.users.find((x) => x.name === name)
    if (u) closeHost(u, client)
  }
  if (failed) {
    if (failed !== 'failed') steps.push({ step: 5, name: 'switch', level: 'fail', message: failed })
    return report
  }
  pass(
    7,
    'canaries',
    "no agent user can read the data folder, the vault, the key, settings or the token, list another agent user's home, or signal another's processes",
  )
  report.ok = true
  return report
}

// ── The real machine ────────────────────────────────────────────────────

function workDirProblemOnDisk(dir: string, serverUid: number): string | null {
  const abs = path.resolve(dir)
  try {
    fs.mkdirSync(abs, { recursive: true, mode: 0o711 })
  } catch (err) {
    return `CLAWBOO_WORK_DIR (${abs}) cannot be made: ${(err as Error).message}`
  }
  const st = fs.lstatSync(abs)
  if (!st.isDirectory() || st.isSymbolicLink()) return `CLAWBOO_WORK_DIR (${abs}) is not a folder.`
  if (st.uid !== serverUid) {
    return `CLAWBOO_WORK_DIR (${abs}) belongs to uid ${st.uid}. With a user per agent it must be the server user's (each share in it is made by the server).`
  }
  if ((st.mode & 0o7777) !== 0o711) fs.chmodSync(abs, 0o711)
  const parents = unsafeParents(abs)
  if (parents.length > 0) {
    return `${parents[0]} can be changed by users other than the one Clawboo runs as, so the work folder inside it cannot be protected.`
  }
  return null
}

function hasSetfaclOnPath(): boolean {
  const dirs = (process.env['PATH'] ?? '/usr/bin:/bin').split(':')
  return [...dirs, '/usr/bin', '/bin'].some((d) => d && fs.existsSync(path.join(d, 'setfacl')))
}

async function openPoolHost(
  config: AgentPoolConfig,
  user: PoolUser,
  group: PoolGroup | null,
  env: NodeJS.ProcessEnv,
): Promise<AgentHostClient> {
  const script = resolveAgentHostScript(env)
  if (!fs.existsSync(script)) {
    throw new Error(`the agent host script ${script} is missing; build Clawboo first`)
  }
  const { transport } = startHostViaSwitch({
    user: user.name,
    switch: config.switch,
    node: process.execPath,
    script,
    prefix: noNewPrivsPrefix(),
    group: group?.name ?? null,
  })
  const client = new AgentHostClient(transport)
  try {
    await client.waitForHello()
  } catch (err) {
    client.close('no hello')
    throw err
  }
  return client
}

/** The real check's dependencies. */
export function poolCheckDepsFor(
  config: AgentPoolConfig,
  env: NodeJS.ProcessEnv,
  opts: {
    accessToken: string | null
    secretValues: string[]
    runtimeBinaries: { runtime: string; path: string }[]
  },
): PoolCheckDeps {
  const explicitWork = env['CLAWBOO_WORK_DIR']?.trim()
  const serverUid = typeof process.getuid === 'function' ? process.getuid() : -1
  return {
    platform: process.platform,
    serverUid,
    serverGid: typeof process.getgid === 'function' ? process.getgid() : -1,
    serverUser: currentUserName(),
    serverHome: os.homedir(),
    serverPid: process.pid,
    serverGroups: typeof process.getgroups === 'function' ? process.getgroups() : [],
    accountDb: getentAccountDb(getentRun),
    accessToken: opts.accessToken,
    dataDir: resolveClawbooDir(env),
    workDir: explicitWork ? path.resolve(explicitWork) : null,
    protectedFiles: protectedFiles(env),
    operatorFiles: operatorFiles(),
    secretValues: opts.secretValues,
    runtimeBinaries: opts.runtimeBinaries,
    narrowDataDir,
    unsafeParents,
    dataDirProblem,
    workDirProblem: (dir) => workDirProblemOnDisk(dir, serverUid),
    hasSetfacl: hasSetfaclOnPath,
    openHost: (u, g) => openPoolHost(config, u, g, env),
    reapSync: (u) => reapSync(config, u),
  }
}

/** The boot and exit stop of one user's processes: blocking, three times. */
function reapSync(config: AgentPoolConfig, u: PoolUser): void {
  killAllAgentProcesses({ user: u.name, switch: config.switch, socket: null })
}

export interface StartAgentPoolOptions {
  env?: NodeJS.ProcessEnv
  log: Log
  accessToken: string | null
  secretValues: string[]
  runtimeBinaries: { runtime: string; path: string }[]
}

/**
 * Start a user per agent: run the check, then publish the pool for the spawn
 * seam and the file verbs. Returns the report; the caller refuses to start
 * when `ok` is false.
 */
export async function startAgentPool(opts: StartAgentPoolOptions): Promise<PoolCheckReport> {
  const env = opts.env ?? process.env
  const config = resolveAgentPoolConfig(env)
  if (!config) throw new Error('startAgentPool called with CLAWBOO_AGENT_USERS unset')
  const report = await runAgentPoolCheck(config, poolCheckDepsFor(config, env, opts))
  for (const s of report.steps) {
    if (s.level === 'warn') opts.log.warn({ step: s.step }, `Agent isolation: ${s.message}`)
  }
  if (!report.ok) return report

  const serverUid = typeof process.getuid === 'function' ? process.getuid() : -1
  const pool = new AgentPool({
    users: report.users,
    groups: report.groups,
    serverGid: typeof process.getgid === 'function' ? process.getgid() : -1,
    open: (u, g) => openPoolHost(config, u, g, env),
    reap: (u) => reapPoolUser(config.switch, u.name),
    reapSync: (u) => reapSync(config, u),
    log: opts.log,
  })
  setActiveAgentPool(pool)
  setWorkLayout('work')
  const workDir = workDirInUse(env)
  const reviewsSegment = path.basename(reviewsRoot(getDb(), env))
  const layout = (): ShareLayout => ({ workDir, reviewsSegment })
  setShareContext({
    layout,
    deps: { serverUid, setAcl: (dir, gid) => setShareAcl(dir, gid) },
  })
  setPathRouteDeps(() => ({
    users: report.users,
    workDir,
    reviewsSegment,
    agentForSegment: (seg) => idForSegment('agents', seg),
    teamForSegment: (seg) => idForSegment('teams', seg),
    taskOwners,
  }))
  for (const top of SHARE_TOPS) {
    ensureStructural(path.join(workDir, top), layout(), { serverUid, setAcl: setShareAcl })
  }
  ensureStructural(path.join(workDir, 'reviews', reviewsSegment), layout(), {
    serverUid,
    setAcl: setShareAcl,
  })
  for (const u of report.users) {
    apart.push(keepRuntimesDirApartFrom(`${u.name}'s home`, () => u.home))
  }
  setUnavailableAgentBinaries(report.unavailableRuntimes)
  poolUnavailable = report.unavailableRuntimes
  // A user whose uid changed, or a new name with the uid of a user the records
  // already hold: its files belong to whoever had that uid before, so it is
  // never handed out (or kept) without a person looking.
  const recorded = listAgentOsUsers(getDb())
  for (const u of report.users) {
    const same = recorded.find((r) => r.userName === u.name)
    const twin = recorded.find(
      (r) => r.uid === u.uid && r.userName !== u.name && r.state !== 'free',
    )
    const why =
      same && same.uid !== u.uid && same.state !== 'free'
        ? `${u.name} had uid ${same.uid} and now has ${u.uid}`
        : twin
          ? `${u.name} has uid ${u.uid}, which ${twin.userName} had`
          : null
    if (why) {
      stopAgentPool()
      report.ok = false
      report.steps.push({
        step: 2,
        name: 'agent users',
        level: 'fail',
        message: `${why}, and that uid's files may be another agent's. Give it back its uid, or delete that user's agent first.`,
      })
      return report
    }
  }
  syncPoolRecords(report.users, report.groups)
  const pass = runAssignmentPass()
  logPass(pass, opts.log)
  // Each minute, also stop hosts that no longer match their agent or team, and
  // retry what a release could not finish.
  pool.startIdleSweep(() => void releaseDeleted())
  poolLog = opts.log
  poolLayout = layout
  // Serialized with every later release, so two never wipe the same user.
  releasing = scrubReleased(pass, opts.log).catch(() => undefined)
  opts.log.info(
    { users: report.users.length, groups: report.groups.length, workDir },
    'Agent isolation: each agent runs as its own user',
  )
  return report
}

const apart: (() => void)[] = []
let poolLog: Log | null = null
let poolLayout: (() => ShareLayout) | null = null
let releasing: Promise<void> = Promise.resolve()

/**
 * After agents or teams were deleted, or an agent changed team: hosts that no
 * longer match are stopped, and the users and groups of what was deleted are
 * wiped and handed back (to the oldest agent or team waiting), one release at
 * a time. Does nothing without a pool.
 */
export function releaseDeleted(): Promise<void> {
  const log = poolLog
  if (!peekAgentPool() || !log) return Promise.resolve()
  releasing = releasing
    .then(() => scrubReleased(runAssignmentPass(), log))
    .catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Agent isolation: could not hand back the users of deleted agents',
      )
    })
  return releasing
}

/** Every root a share may have, from its segment. */
function shareRoots(seg: string, layout: ShareLayout): string[] {
  const w = layout.workDir
  return [
    path.join(w, 'teams', seg),
    path.join(w, 'mirrors', seg),
    path.join(w, 'team-history', `${seg}.git`),
    path.join(w, 'reviews', layout.reviewsSegment, seg),
    path.join(w, 'reviews', layout.reviewsSegment, `team-${seg}`),
  ]
}

/** Empty and remove the roots that are there, through `client` (a host of the share). */
async function removeShareRoots(client: AgentHostClient, roots: string[]): Promise<void> {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    // The host empties it; the root's own folder is in one of the server's.
    await emptyFolderVia(client, root, root)
    removeEmptiedRoot(root)
  }
}
let poolUnavailable: PoolCheckReport['unavailableRuntimes'] = []

/** What `/api/health` says about a pool: null without one. */
export function poolIsolationStatus(): {
  mode: 'pool'
  users: number
  groups: number
  hostsRunning: number
  unavailableRuntimes: { runtime: string; path: string; reason: string }[]
} | null {
  const pool = peekAgentPool()
  if (!pool) return null
  return {
    mode: 'pool',
    users: pool.users.length,
    groups: pool.groups.length,
    hostsRunning: pool.runningHosts().length,
    unavailableRuntimes: poolUnavailable,
  }
}

/** The id whose path segment is `seg` (ids are kept as they are when already safe). */
function idForSegment(table: 'agents' | 'teams', seg: string): string | null {
  const db = getDb()
  const t = table === 'agents' ? agents : teams
  const direct = db.select({ id: t.id }).from(t).all()
  return (
    direct.find((r) => r.id === seg)?.id ??
    direct.find((r) => sanitizeAgentId(r.id) === seg)?.id ??
    null
  )
}

function logPass(pass: PoolPass, log: Log): void {
  if (pass.users.waiting.length > 0) {
    log.warn(
      { waiting: pass.users.waiting.length },
      'Agent isolation: some agents have no agent user (every user in CLAWBOO_AGENT_USERS is taken); their runs refuse until one is free',
    )
  }
  if (pass.groups.waiting.length > 0) {
    log.warn(
      { waiting: pass.groups.waiting.length },
      'Agent isolation: some teams have no group (CLAWBOO_AGENT_GROUPS); their agents cannot reach their team folder until one is free',
    )
  }
}

/**
 * Stop the hosts that no longer match their agent: the agent was deleted, or
 * moved to another team (its host still holds the old team's group). Each is
 * stopped with every process of its user; the next need starts it with the
 * right group. Hosts borrowed for a scrub are left alone.
 */
export async function reconcilePoolHosts(log: Log): Promise<void> {
  const pool = peekAgentPool()
  if (!pool) return
  for (const h of pool.runningHosts()) {
    if (borrowed.has(h.user.name)) continue
    const agentId = agentOfPoolUser(h.user.name)
    let want: string | null | undefined
    if (agentId) {
      try {
        want = shareGroupNameFor(agentId)
      } catch {
        want = undefined
      }
    }
    if (want !== undefined && (h.group?.name ?? null) === want) continue
    log.info(
      { user: h.user.name },
      "Agent isolation: an agent's host no longer matches its agent or team; stopping it",
    )
    pool.close(h.user.name, 'its agent or team changed')
    await pool.settled(h.user.name)
  }
}

/** Users borrowed by a scrub right now. */
const borrowed = new Set<string>()

/** Still being wiped, as the records say (another release may have finished it). */
function stillScrubbing(name: string): boolean {
  return agentOsUserRow(getDb(), name)?.state === 'scrubbing'
}

/**
 * Remove every file of `uid` in the shared temporary folders, through `client`
 * (that user's host), then look again: anything still there keeps the user out
 * of use. Throws with what is left.
 */
async function wipeTempFiles(client: AgentHostClient, uid: number): Promise<void> {
  const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      let out = ''
      const p = client.spawn({
        command: 'find',
        args,
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'ignore'],
        group: true,
      })
      p.stdout?.on('data', (d: Buffer) => {
        if (out.length < 4096) out += d.toString()
      })
      p.once('error', () => resolve({ code: -1, out }))
      p.once('close', (code) => resolve({ code, out }))
    })
  const dirs = ['/tmp', '/var/tmp', '/dev/shm', `/run/user/${uid}`].filter((d) => fs.existsSync(d))
  await run([...dirs, '-xdev', '-mindepth', '1', '-user', String(uid), '-delete'])
  const left = await run([...dirs, '-xdev', '-mindepth', '1', '-user', String(uid), '-print'])
  // `find` exits 1 whenever it meets a folder it may not enter (another user's
  // private one), which is normal: what it prints decides. Only a find that
  // never ran says nothing.
  if (left.code === -1 || left.out.trim() !== '') {
    throw new Error(
      `files of uid ${uid} are left in the temporary folders: ${left.out.trim().slice(0, 300) || 'find did not run'}`,
    )
  }
}

/**
 * Wipe the users of deleted agents, then free them: every process stopped, the
 * home emptied (and found empty), its temporary files removed (and none found
 * after), its folders of no team removed, all through its own host. Then the
 * folders of deleted teams go, through a borrowed user's host with that team's
 * group, and a group is freed only once no running host still holds it. The
 * next agent or team that gets one starts from nothing the last one left.
 * Callers serialize through `releaseDeleted`.
 */
export async function scrubReleased(pass: PoolPass, log: Log): Promise<void> {
  const pool = peekAgentPool()
  if (!pool) return
  await reconcilePoolHosts(log)
  for (const { name, ownerId: formerAgent } of pass.users.scrubbing) {
    const user = pool.user(name)
    if (!user || !formerAgent || !stillScrubbing(name)) continue
    try {
      pool.close(name, 'its agent was deleted')
      await pool.settled(name)
      if (!stillScrubbing(name)) continue
      const client = await pool.hostFor(name, null)
      const home = path.resolve(user.home)
      await emptyFolderVia(client, home)
      const layout = poolLayout?.()
      if (layout) {
        const seg = `${AGENT_SHARE_PREFIX}${sanitizeAgentId(formerAgent)}`
        await removeShareRoots(client, shareRoots(seg, layout))
      }
      await wipeTempFiles(client, user.uid)
      pool.close(name, 'wiped')
      await pool.settled(name)
      finishAgentOsUserScrub(getDb(), name)
      log.info(
        { user: name },
        "Agent isolation: a deleted agent's user was wiped and is free again",
      )
    } catch (err) {
      pool.close(name, 'the wipe failed')
      log.warn(
        { user: name, err: err instanceof Error ? err.message : String(err) },
        "Agent isolation: could not wipe a deleted agent's user; it stays out of use",
      )
    }
  }
  // A deleted team's folders go before its group is handed out again.
  for (const { name, ownerId: formerTeam } of pass.groups.scrubbing) {
    const layout = poolLayout?.()
    if (!layout || !formerTeam) break
    const roots = shareRoots(sanitizeAgentId(formerTeam), layout).filter((r) => fs.existsSync(r))
    if (roots.length > 0) {
      const lender = borrowFreeAgentOsUser(getDb())
      if (!lender || !pool.user(lender)) {
        if (lender) finishAgentOsUserScrub(getDb(), lender)
        log.warn(
          { group: name },
          "Agent isolation: a deleted team's folders wait for a free agent user to remove them; its group stays out of use",
        )
        continue
      }
      borrowed.add(lender)
      try {
        const client = await pool.hostFor(lender, name)
        await removeShareRoots(client, roots)
      } catch (err) {
        log.warn(
          { group: name, err: err instanceof Error ? err.message : String(err) },
          "Agent isolation: could not remove a deleted team's folders; its group stays out of use",
        )
        continue
      } finally {
        pool.close(lender, "removed a deleted team's folders")
        await pool.settled(lender)
        borrowed.delete(lender)
        finishAgentOsUserScrub(getDb(), lender)
      }
    }
    // A former member's host may still hold the group: never free it then.
    if (pool.runningHosts().some((h) => h.group?.name === name)) {
      log.warn(
        { group: name },
        "Agent isolation: a deleted team's group is still held; it stays out of use",
      )
      continue
    }
    finishTeamOsGroupScrub(getDb(), name)
    log.info({ group: name }, "Agent isolation: a deleted team's group is free again")
  }
  if (pass.users.scrubbing.length + pass.groups.scrubbing.length > 0)
    logPass(runAssignmentPass(), log)
}

/** At shutdown, after the graceful pass: stop every host and every pool user's processes. */
export function stopAgentPool(): void {
  const pool = peekAgentPool()
  if (!pool) return
  pool.closeAll('the server is stopping')
  setActiveAgentPool(null)
  setPathRouteDeps(null)
  setShareContext(null)
  poolLog = null
  poolLayout = null
  for (const off of apart.splice(0)) off()
}
