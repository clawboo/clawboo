// Agent isolation at boot and at shutdown.
//
// With CLAWBOO_AGENT_USER set, the server starts (or reaches) the agent host,
// runs the startup check, and only then lets anything run. With it unset none
// of this runs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveClawbooDir, resolveSettingsPath, resolveAccessTokenPath } from '@clawboo/config'

import { getVaultPaths } from '../secretsVault'
import { agentMkdir, agentRemove, agentStat, agentWriteFile } from './agentFs'
import {
  dataDirProblem,
  narrowDataDir,
  runAgentUserCheck,
  unsafeParents,
  type CheckDeps,
  type CheckReport,
} from './check'
import {
  AgentHostClient,
  connectHostSocket,
  startHostViaSwitch,
  type HostTransport,
} from './client'
import { resolveAgentUserConfig, type AgentUserConfig } from './config'
import { setUnavailableAgentBinaries } from '../runtimes/spawner'
import type { HelloFrame } from './protocol'
import { keepRuntimesDirApartFrom } from '../runtimeFolder'
import { peekAgentHost, setActiveAgentHost } from './state'
import { currentUserName, killAllAgentProcesses, lookupUser, socketProblem } from './system'
import { installAgentWorktreeIo } from './worktreeIo'

type Log = {
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}

/** Where the bundled host script is: beside the server bundle, or the build
 *  output when the server runs from source. CLAWBOO_AGENT_HOST_SCRIPT wins. */
export function resolveAgentHostScript(env: NodeJS.ProcessEnv = process.env): string {
  const set = env['CLAWBOO_AGENT_HOST_SCRIPT']?.trim()
  if (set) return set
  const candidates = [
    path.join(__dirname, 'agent-host.js'),
    // From source (`tsx server/index.ts`): apps/web/server/lib/agentUser -> apps/web/dist.
    path.resolve(__dirname, '..', '..', '..', 'dist', 'agent-host.js'),
  ]
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!
}

/** The files the agent user must never read (design 4.6 step 7). */
export function protectedFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const data = resolveClawbooDir(env)
  const db = path.join(data, 'clawboo.db')
  const vault = getVaultPaths()
  return [
    db,
    `${db}-wal`,
    `${db}-shm`,
    vault.masterKey,
    vault.vault,
    resolveSettingsPath(env),
    resolveAccessTokenPath(env),
  ]
}

/** The operator's own logins (design 4.6 step 7). */
export function operatorFiles(home: string = os.homedir()): string[] {
  return [
    path.join(home, '.openclaw', '.env'),
    // The Gateway's own token: with it an agent could drive the OpenClaw Gateway,
    // which runs as the server's user.
    path.join(home, '.openclaw', 'openclaw.json'),
    path.join(home, '.codex', 'auth.json'),
    path.join(home, '.hermes', 'auth.json'),
    path.join(home, '.claude', '.credentials.json'),
  ]
}

export interface StartAgentUserOptions {
  env?: NodeJS.ProcessEnv
  log: Log
  accessToken: string | null
  secretValues: string[]
  runtimeBinaries: { runtime: string; path: string }[]
}

let watchStop: (() => void) | null = null

/** Wait (at most 30 s) for the server this one replaces to exit. */
async function waitForPreviousServer(env: NodeJS.ProcessEnv): Promise<void> {
  const pid = Number(env['CLAWBOO_AWAIT_PID'])
  delete env['CLAWBOO_AWAIT_PID']
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}
let restarting = false

/**
 * On Linux, start the host under `setpriv --no-new-privs` when it is there: no
 * agent process can then gain another user through a setuid file (one an agent
 * planted while it still ran as the server's user, say). macOS has no such
 * switch; there the startup check refuses setuid files in the work folder.
 */
function noNewPrivsPrefix(): string[] {
  if (process.platform !== 'linux') return []
  const setpriv = ['/usr/bin/setpriv', '/bin/setpriv'].find((p) => fs.existsSync(p))
  return setpriv ? [setpriv, '--no-new-privs'] : []
}

async function openHost(config: AgentUserConfig, env: NodeJS.ProcessEnv): Promise<AgentHostClient> {
  let transport: HostTransport
  if (config.socket) {
    transport = await connectHostSocket(config.socket)
  } else {
    const script = resolveAgentHostScript(env)
    if (!fs.existsSync(script)) {
      throw new Error(`the agent host script ${script} is missing; build Clawboo first`)
    }
    transport = startHostViaSwitch({
      user: config.user,
      switch: config.switch,
      node: process.execPath,
      script,
      prefix: noNewPrivsPrefix(),
    }).transport
  }
  return new AgentHostClient(transport)
}

/** The startup check's dependencies, for the server and for `clawboo agent-user check`. */
export function checkDepsFor(
  config: AgentUserConfig,
  env: NodeJS.ProcessEnv,
  opts: Pick<StartAgentUserOptions, 'accessToken' | 'secretValues' | 'runtimeBinaries'>,
): CheckDeps {
  const explicitWork = env['CLAWBOO_WORK_DIR']?.trim()
  return {
    platform: process.platform,
    serverUid: typeof process.getuid === 'function' ? process.getuid() : -1,
    serverPid: process.pid,
    serverHome: os.homedir(),
    lookupUser,
    accessToken: opts.accessToken,
    dataDir: resolveClawbooDir(env),
    protectedFiles: protectedFiles(env),
    operatorFiles: operatorFiles(),
    workDirFor: (hello: HelloFrame) =>
      explicitWork
        ? { dir: path.resolve(explicitWork), create: false }
        : { dir: path.join(hello.home, 'work'), create: true },
    secretValues: opts.secretValues,
    runtimeBinaries: opts.runtimeBinaries,
    narrowDataDir,
    unsafeParents,
    dataDirProblem,
    startHost: (c) => openHost(c, env),
    socketProblem: (p, uid) => socketProblem(p, uid),
    stopHost: (client) => client.close('the startup check failed'),
  }
}

/**
 * Start agent isolation: reap what a previous server left, start the host, run
 * the check. On success the host is published for the spawn seam and watched.
 * Returns the report; the caller refuses to start when `ok` is false.
 */
export async function startAgentUser(opts: StartAgentUserOptions): Promise<CheckReport> {
  const env = opts.env ?? process.env
  const config = resolveAgentUserConfig(env)
  if (!config) throw new Error('startAgentUser called with CLAWBOO_AGENT_USER unset')

  // A restart after an update: the previous server stops every agent process as
  // it exits, and doing that after this one's host started would stop it too.
  await waitForPreviousServer(env)

  // Before the host starts: anything the agent user still runs belongs to a
  // server that is gone (design 4.8).
  if (!config.socket) killAllAgentProcesses(config)

  const explicitWork = env['CLAWBOO_WORK_DIR']?.trim()
  const report = await runAgentUserCheck(config, checkDepsFor(config, env, opts), {
    serverUser: currentUserName(),
  })
  for (const s of report.steps) {
    if (s.level === 'warn') opts.log.warn({ step: s.step }, `Agent isolation: ${s.message}`)
  }
  if (!report.ok || !report.client || !report.hello || !report.workDir) return report

  setActiveAgentHost({ client: report.client, hello: report.hello, config })
  keepRuntimesApartFromAgentHome()
  // Task checkouts and the agent user's copies of repositories: their git and
  // file access go through the host from here on.
  installAgentWorktreeIo()
  setUnavailableAgentBinaries(report.unavailableRuntimes)
  lastUnavailable = report.unavailableRuntimes
  // Every resolver of the work folder agrees from here on.
  if (!explicitWork) env['CLAWBOO_WORK_DIR'] = report.workDir
  await prepareAgentWorkDir(report.workDir)
  // Throwaway runtime homes (reviewer runs, checks) a previous server left: no
  // run is going yet, so none is in use.
  await agentRemove(path.join(report.hello.home, 'runtimes', '.throwaway')).catch(() => undefined)
  watchHost(config, env, opts.log)
  opts.log.info(
    { user: config.user, uid: report.hello.uid, home: report.hello.home, workDir: report.workDir },
    'Agent isolation: agents run as their own user',
  )
  return report
}

const README = `This is Clawboo's work folder: team folders, task checkouts and review
checkouts live here. Agents run as this folder's owner. Do not move it while
Clawboo is running.
`

/** The work folder's layout, made through the host (the server cannot write there). */
export async function prepareAgentWorkDir(dir: string): Promise<void> {
  await agentMkdir(dir)
  for (const sub of ['teams', 'worktrees', 'reviews', 'mirrors'])
    await agentMkdir(path.join(dir, sub))
  if (!(await agentStat(path.join(dir, 'README.txt')))) {
    await agentWriteFile(path.join(dir, 'README.txt'), README)
  }
}

/**
 * Watch the host. When it stops answering for 5 seconds (design 4.8):
 * - started through a switch: stop every agent process, then start a new host
 *   and check its identity again; runs fail with a clear error meanwhile;
 * - reached on a launcher's socket: exit, so the launcher stops every agent
 *   process and its restart policy starts both again.
 */
function watchHost(config: AgentUserConfig, env: NodeJS.ProcessEnv, log: Log): void {
  watchStop?.()
  const active = peekAgentHost()
  if (!active) return
  watchStop = active.client.watch(
    (reason) => {
      if (config.socket) {
        log.error(
          { reason },
          'Agent isolation: the agent host is gone; exiting so the launcher restarts both',
        )
        process.exit(1)
      }
      log.error(
        { reason },
        'Agent isolation: the agent host stopped answering; stopping every agent process',
      )
      active.client.close(reason)
      killAllAgentProcesses(config)
      void restartHost(config, env, active.hello, log)
    },
    { everyMs: 2_000, deadMs: 5_000 },
  )
}

async function restartHost(
  config: AgentUserConfig,
  env: NodeJS.ProcessEnv,
  expected: HelloFrame,
  log: Log,
): Promise<void> {
  if (restarting) return
  restarting = true
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * 2 ** attempt)))
      try {
        const client = await openHost(config, env)
        const hello = await client.waitForHello()
        if (
          hello.uid !== expected.uid ||
          hello.gid !== expected.gid ||
          hello.home !== expected.home
        ) {
          client.close('identity changed')
          log.error(
            { hello },
            'Agent isolation: the restarted agent host is a different user; not using it',
          )
          return
        }
        setActiveAgentHost({ client, hello, config })
        watchHost(config, env, log)
        log.info({ attempt }, 'Agent isolation: the agent host is running again')
        return
      } catch (err) {
        log.warn({ err, attempt }, 'Agent isolation: could not restart the agent host')
      }
    }
    log.error(
      'Agent isolation: the agent host could not be restarted; runs will fail until Clawboo restarts',
    )
  } finally {
    restarting = false
  }
}

let lastUnavailable: CheckReport['unavailableRuntimes'] = []

/**
 * What `/api/health` says about agent isolation: null when it is off; the
 * agent user, whether its host is running, and the runtimes it cannot run.
 */
export function agentIsolationStatus(): {
  user: string
  uid: number
  home: string
  host: 'running' | 'down'
  unavailableRuntimes: { runtime: string; path: string; reason: string }[]
} | null {
  const active = peekAgentHost()
  if (!active) return null
  return {
    user: active.config.user,
    uid: active.hello.uid,
    home: active.hello.home,
    host: active.client.closed ? 'down' : 'running',
    unavailableRuntimes: lastUnavailable,
  }
}

/** At shutdown, after the graceful pass: stop every agent process and the host. */
export function stopAgentUser(): void {
  watchStop?.()
  watchStop = null
  const active = peekAgentHost()
  if (!active) return
  killAllAgentProcesses(active.config)
  active.client.close('the server is stopping')
  setActiveAgentHost(null)
}

let apartFromAgentHome: (() => void) | null = null

/**
 * Keep the runtimes folder apart from the agent user's home, which agents can
 * write: a runtime there could be changed by an agent. Registered once; the
 * home is read at each check, so it follows a host that reconnects.
 */
export function keepRuntimesApartFromAgentHome(): void {
  if (apartFromAgentHome) return
  apartFromAgentHome = keepRuntimesDirApartFrom(
    "the agent user's home",
    () => peekAgentHost()?.hello.home ?? null,
  )
}
