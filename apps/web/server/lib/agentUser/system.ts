// The parts of agent isolation that ask the operating system something or
// stop processes: user lookup, the launcher socket's ownership, and "stop every
// agent process" (design 4.8).

import { execFileSync, spawnSync } from 'node:child_process'
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
