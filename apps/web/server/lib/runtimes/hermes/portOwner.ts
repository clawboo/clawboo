// Who answers on the Hermes gateway's port, checked before Clawboo sends it a key.
//
// The port is probed before the gateway starts, but a probe and a bind are two
// moments: another program can take the port between them (another user's, on a
// shared computer), and Hermes then fails its bind and keeps running with no
// listener. Whoever answers on the port would get the gateway key, and with it
// every profile key, every run's input and the power to send back fake results
// and approval cards. So before the first keyed call the listener is matched
// against the process Clawboo started:
//
// - macOS: `netstat -anv` names the process behind every listener, other users'
//   included; the listener must be the gateway or a process it started.
// - Linux: `/proc/net/tcp` names each listener's user, readable by everyone; it
//   must be the gateway's user (a process of that user can read the keys from
//   the gateway's home anyway, so the user is the boundary that matters).
// - Windows: `netstat -ano` names the listener's process.
//
// When the owner cannot be read (a tool missing or an output not understood),
// the answer is `unknown` and the start goes on: the check guards against a
// listener it can see is someone else's, and never stops Hermes for a format it
// does not know.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

import { parseNetstatPid } from '@clawboo/process-lookup'

export type PortOwner = 'ours' | 'other' | 'unknown'

export interface PortOwnerDeps {
  platform?: NodeJS.Platform
  /** Run a command; resolves with its stdout, rejects when it fails. */
  run?: (command: string, args: string[]) => Promise<string>
  readFile?: (file: string) => Promise<string>
}

function defaultRun(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}

/**
 * The processes listening on `port` in `netstat -anv -p tcp` output (macOS):
 * the ones on 127.0.0.1 when there are any (loopback traffic goes to the more
 * specific bind), else the ones on every address.
 */
export function parseDarwinListeners(stdout: string, port: number): number[] {
  const loopback: number[] = []
  const wildcard: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (!/^tcp4?6?$/.test(cols[0] ?? '') || !/\bLISTEN\b/.test(line)) continue
    const local = cols[3] ?? ''
    if (!local.endsWith(`.${port}`)) continue
    const host = local.slice(0, -`.${port}`.length)
    // `name:pid`, then the state and options columns, in hex. Anchored on those
    // so a process name with a space in it cannot shift the match.
    const m = /:(\d+)\s+[0-9a-f]{5}\s+[0-9a-f]{8}\s/i.exec(line)
    const pid = m ? Number(m[1]) : NaN
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (host === '127.0.0.1') loopback.push(pid)
    else if (host === '*') wildcard.push(pid)
  }
  return loopback.length > 0 ? loopback : wildcard
}

/**
 * The users listening on `port` in `/proc/net/tcp` (Linux): the ones on
 * 127.0.0.1 when there are any, else the ones on every address.
 */
export function parseProcNetTcpListeners(text: string, port: number): number[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  const loopback: number[] = []
  const wildcard: number[] = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
    if (cols.length < 8 || cols[3] !== '0A') continue
    const [addr, p] = (cols[1] ?? '').split(':')
    if ((p ?? '').toUpperCase() !== hexPort) continue
    const uid = Number(cols[7])
    if (!Number.isInteger(uid) || uid < 0) continue
    if (addr === '0100007F') loopback.push(uid)
    else if (addr === '00000000') wildcard.push(uid)
  }
  return loopback.length > 0 ? loopback : wildcard
}

/** The effective user of a process, from `/proc/<pid>/status`. */
export function parseStatusUid(text: string): number | null {
  const m = /^Uid:\s+\d+\s+(\d+)/m.exec(text)
  return m ? Number(m[1]) : null
}

/** The parent of a process, or null when it cannot be read. */
async function parentOf(
  pid: number,
  platform: NodeJS.Platform,
  run: NonNullable<PortOwnerDeps['run']>,
): Promise<number | null> {
  try {
    const out =
      platform === 'win32'
        ? await run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
          ])
        : await run('ps', ['-o', 'ppid=', '-p', String(pid)])
    const parent = Number(out.trim())
    return Number.isInteger(parent) && parent > 0 ? parent : null
  } catch {
    return null
  }
}

/** Whether `pid` is `ancestor` or was started by it (a launcher's child). */
async function startedBy(
  pid: number,
  ancestor: number,
  platform: NodeJS.Platform,
  run: NonNullable<PortOwnerDeps['run']>,
): Promise<boolean | null> {
  let at: number | null = pid
  for (let depth = 0; at !== null && depth < 8; depth++) {
    if (at === ancestor) return true
    if (at <= 1) return false
    const parent: number | null = await parentOf(at, platform, run)
    if (parent === null) return null
    at = parent
  }
  return false
}

/** Whether the process listening on `port` is the gateway Clawboo started as `pid`. */
export async function gatewayPortOwner(
  port: number,
  pid: number,
  deps: PortOwnerDeps = {},
): Promise<PortOwner> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? defaultRun
  const read = deps.readFile ?? ((f: string) => readFile(f, 'utf8'))
  try {
    if (platform === 'linux') {
      const uids = parseProcNetTcpListeners(await read('/proc/net/tcp'), port)
      if (uids.length === 0) return 'unknown'
      const uid = parseStatusUid(await read(`/proc/${pid}/status`))
      if (uid === null) return 'unknown'
      return uids.includes(uid) ? 'ours' : 'other'
    }
    let pids: number[]
    if (platform === 'darwin') {
      pids = parseDarwinListeners(await run('netstat', ['-anv', '-p', 'tcp']), port)
    } else if (platform === 'win32') {
      const one = parseNetstatPid(await run('netstat', ['-ano']), port)
      pids = one === null ? [] : [one]
    } else {
      return 'unknown'
    }
    if (pids.length === 0) return 'unknown'
    let unreadable = false
    for (const listener of pids) {
      const ours = await startedBy(listener, pid, platform, run)
      if (ours === true) return 'ours'
      if (ours === null) unreadable = true
    }
    return unreadable ? 'unknown' : 'other'
  } catch {
    return 'unknown'
  }
}
