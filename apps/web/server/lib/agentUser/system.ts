// The parts of agent isolation that ask the operating system something or
// stop processes: user lookup, the launcher socket's ownership, and "stop every
// agent process" (design 4.8).

import { execFile, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { AgentUserConfig } from './config'
import type { UserRecord } from './check'

/** `id -u` and `id -g` for a user name, or null when there is no such user. */
export function lookupUser(name: string): UserRecord | null {
  try {
    const uid = Number(
      execFileSync('id', ['-u', name], { encoding: 'utf8', timeout: 5_000 }).trim(),
    )
    const gid = Number(
      execFileSync('id', ['-g', name], { encoding: 'utf8', timeout: 5_000 }).trim(),
    )
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null
    return { uid, gid }
  } catch {
    return null
  }
}

/** The name of the user this process runs as. */
export function currentUserName(): string {
  try {
    return execFileSync('id', ['-un'], { encoding: 'utf8', timeout: 5_000 }).trim() || 'clawboo'
  } catch {
    return process.env['USER'] ?? 'clawboo'
  }
}

/**
 * The launcher's contract for the socket (design 4.3): its folder is owned by
 * the agent uid and the server's group with mode 0710, and the socket by the
 * same pair with mode 0660. Only root or the agent can make a socket there, so
 * the peer is the host or something the agents already control. Anything else
 * is refused before connecting. Null when it matches.
 */
export function socketProblem(
  socketPath: string,
  agentUid: number,
  serverGid: number = typeof process.getgid === 'function' ? process.getgid() : -1,
): string | null {
  const dir = path.dirname(socketPath)
  const fix = `The launcher must create ${dir} owned by the agent user and this server's group with mode 0710, and the socket with mode 0660.`
  let d: fs.Stats
  try {
    d = fs.lstatSync(dir)
  } catch (err) {
    return `${dir} is missing (${(err as { code?: string }).code ?? 'error'}). ${fix}`
  }
  if (!d.isDirectory()) return `${dir} is not a folder. ${fix}`
  if (d.uid !== agentUid || d.gid !== serverGid || (d.mode & 0o7777) !== 0o710) {
    return `${dir} is owned by uid ${d.uid} gid ${d.gid} with mode ${(d.mode & 0o7777).toString(8)}. ${fix}`
  }
  let s: fs.Stats
  try {
    s = fs.lstatSync(socketPath)
  } catch (err) {
    return `${socketPath} is missing (${(err as { code?: string }).code ?? 'error'}). Is the agent host running?`
  }
  if (!s.isSocket()) return `${socketPath} is not a socket. ${fix}`
  if (s.uid !== agentUid || s.gid !== serverGid || (s.mode & 0o777) !== 0o660) {
    return `${socketPath} is owned by uid ${s.uid} gid ${s.gid} with mode ${(s.mode & 0o777).toString(8)}. ${fix}`
  }
  return null
}

/**
 * Stop every process the agent user owns, without the host's help:
 * `sudo -n -u <agent> -- kill -KILL -1`, three times (a fork loop can outrun one).
 *
 * Used at boot before the host starts (it also reaps what a crashed server
 * left), when the host stops answering, and at shutdown after the graceful pass.
 * This is why the agent user must belong to one install only.
 *
 * In socket mode the server has no switch; the launcher does this when either
 * process exits, so this is a no-op there. Synchronous so it can run from the
 * exit hook. Returns whether the switch ran.
 */
export function killAllAgentProcesses(
  config: AgentUserConfig,
  run: typeof spawnSync = spawnSync,
): boolean {
  if (config.socket) return false
  let ran = false
  for (let i = 0; i < 3; i++) {
    const res = run(config.switch, ['-n', '-u', config.user, '--', 'kill', '-KILL', '-1'], {
      stdio: 'ignore',
      timeout: 5_000,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin' },
    })
    if (!res.error) ran = true
  }
  return ran
}

// ── A user per agent (CLAWBOO_AGENT_USERS) ──────────────────────────────

/** `getent <db> <key>`'s output, or null when there is no such entry. */
export function getentRun(args: string[]): string | null {
  try {
    return execFileSync('getent', args, { encoding: 'utf8', timeout: 5_000 })
  } catch {
    return null
  }
}

/** Whether stderr from `<switch> -u <user> -- ...` is the switch refusing
 *  (sudo's "a password is required", "Sorry, user ... is not allowed"). */
export function switchRefused(stderr: string): boolean {
  return (
    /^(sudo|doas):/m.test(stderr) ||
    /Sorry, user /.test(stderr) ||
    /not allowed to execute/.test(stderr)
  )
}

const SWITCH_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
})

/**
 * Stop every process of one pool user (`kill -KILL -1` as that user, three
 * times), without blocking: one agent's stop must not hold up the server.
 * First the switch is tried with `true`, which cannot fail on its own: a
 * switch that will not run it cannot run `kill` either, and that rejects
 * (nothing was stopped). `kill` finding nothing left to stop is no failure,
 * but the switch refusing `kill` itself is.
 */
export function reapPoolUser(
  sw: AgentUserConfig['switch'],
  user: string,
  run: typeof execFile = execFile,
): Promise<void> {
  const call = (args: string[]): Promise<{ failed: string | null }> =>
    new Promise((resolve) => {
      run(
        sw,
        ['-n', '-u', user, '--', ...args],
        { timeout: 5_000, env: SWITCH_ENV() },
        (err, _out, stderr) => {
          const text = String(stderr ?? '')
          if (!err) return resolve({ failed: null })
          const c = (err as { code?: unknown }).code
          if (
            typeof c === 'string' ||
            (err as { killed?: boolean }).killed ||
            (err as { signal?: unknown }).signal
          ) {
            return resolve({ failed: text.trim() || (err as Error).message })
          }
          resolve({
            failed: switchRefused(text)
              ? text.trim()
              : args[0] === 'true'
                ? text.trim() || `exited ${String(c)}`
                : null,
          })
        },
      )
    })
  return (async () => {
    const probe = await call(['true'])
    if (probe.failed) throw new Error(`could not stop the processes of ${user}: ${probe.failed}`)
    for (let i = 0; i < 3; i++) {
      const r = await call(['kill', '-KILL', '-1'])
      if (r.failed) throw new Error(`could not stop the processes of ${user}: ${r.failed}`)
    }
  })()
}

/**
 * `kill -KILL -1` as `user`, three times, blocking (boot and exit). Returns
 * why it could not be done (the switch will not run `true` as that user, or
 * refuses `kill`), or null; `kill` finding nothing left to stop is no failure.
 */
export function reapUserSync(
  sw: AgentUserConfig['switch'],
  user: string,
  run: typeof spawnSync = spawnSync,
): string | null {
  const call = (args: string[]): { status: number | null; failed: string | null } => {
    const res = run(sw, ['-n', '-u', user, '--', ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      env: SWITCH_ENV(),
    })
    const stderr = String(res.stderr ?? '')
    if (res.error) return { status: null, failed: res.error.message }
    if (res.signal) return { status: null, failed: `${sw} was stopped by ${res.signal}` }
    if (res.status !== 0 && switchRefused(stderr))
      return { status: res.status, failed: stderr.trim() }
    return { status: res.status, failed: null }
  }
  const probe = call(['true'])
  if (probe.failed) return probe.failed
  if (probe.status !== 0) return `${sw} could not run a command as ${user} (exit ${probe.status})`
  for (let i = 0; i < 3; i++) {
    const r = call(['kill', '-KILL', '-1'])
    if (r.failed) return r.failed
  }
  return null
}

/**
 * Give a share root its inherited ACL (Linux `setfacl`): the share's group may
 * read, write and enter everything made inside, whatever the maker's umask, and
 * nobody else may. The folder is the server's own, just made.
 */
export function setShareAcl(
  dir: string,
  gid: number,
  run: typeof execFile = execFile,
): Promise<void> {
  return new Promise((resolve, reject) => {
    run(
      'setfacl',
      ['-m', `g:${gid}:rwx,d:g:${gid}:rwx,d:m::rwx,d:o::-`, '--', dir],
      { timeout: 10_000 },
      (err) => (err ? reject(err) : resolve()),
    )
  })
}
