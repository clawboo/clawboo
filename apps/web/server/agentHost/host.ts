// The agent host: one long-lived process running as the agent user, which
// starts processes and touches files in agent space on the server's behalf.
//
// It is on the agents' side of the boundary by design. An agent can trace it,
// kill it or forge what it says, and nothing here tries to stop that: the
// server treats every reply as data. What this process must get right is the
// other direction. It takes requests only from the server (its own stdin, or a
// socket only the server's group can reach), it never logs a request (a spawn
// request can carry a provider key in its environment), and it never holds a
// request's environment past the spawn it was for.
//
// Node built-ins only: the bundle runs from the installed package, and the agent
// user can read that package but nothing else of the server's.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'

import {
  O_NONBLOCK,
  appendNoFollow,
  mkdirMode,
  readBounded,
  statType,
  toStat,
  writeAtomic,
} from './fsOps'
import {
  AGENT_HOST_PROTOCOL_VERSION,
  MAX_LIST_REPLY_CHARS,
  MAX_READ_BYTES,
  MAX_SEARCH_MATCHES,
  MAX_WRITE_BYTES,
  createLineSplitter,
  encodeFrame,
  errorCode,
  parseFrame,
  type FsEntry,
  type HelloFrame,
  type HostToServerFrame,
  type InodeRef,
  type ProbeResult,
  type StdioMode,
} from '../lib/agentUser/protocol'

/** Signals a request may name. Anything else is refused. */
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'])

/** How much of a command's output the host returns from its own checks. */
const CHECK_OUTPUT_CHARS = 64 * 1024

/** Who the host is, as the kernel says. */
export function hostIdentity(): Omit<HelloFrame, 't' | 'v'> {
  const info = os.userInfo()
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    gid: typeof process.getgid === 'function' ? process.getgid() : -1,
    user: info.username,
    home: info.homedir,
    pid: process.pid,
    platform: process.platform,
  }
}

/**
 * A child's environment: what the request named, plus the agent user's own
 * identity variables where the request left them out. Nothing of the host's own
 * environment passes through, so neither sudo's policy nor the launcher decides
 * what an agent sees.
 */
export function childEnvFor(requested: Record<string, string>): Record<string, string> {
  const id = os.userInfo()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(requested)) {
    if (typeof k === 'string' && typeof v === 'string' && !k.includes('=') && !k.includes('\0'))
      env[k] = v
  }
  env['HOME'] ??= id.homedir
  env['USER'] ??= id.username
  env['LOGNAME'] ??= id.username
  if (id.shell) env['SHELL'] ??= id.shell
  env['TMPDIR'] ??= os.tmpdir()
  return env
}

/** Every descendant of `pid`, deepest first, from one `ps` snapshot. */
function descendantsOf(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 5_000 }, (err, out) => {
      if (err) return resolve([])
      const children = new Map<number, number[]>()
      for (const line of String(out).split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/)
        if (!m) continue
        const list = children.get(Number(m[2])) ?? []
        list.push(Number(m[1]))
        children.set(Number(m[2]), list)
      }
      const ordered: number[] = []
      const walk = (node: number): void => {
        for (const c of children.get(node) ?? []) walk(c)
        if (node !== pid) ordered.push(node)
      }
      walk(pid)
      resolve(ordered)
    })
  })
}

function trySignal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig)
    return true
  } catch {
    return false
  }
}

interface Proc {
  child: ChildProcess
  group: boolean
}

/** Stop one child and everything it started: SIGTERM, then SIGKILL after the grace. */
async function killTree(proc: Proc, graceMs: number): Promise<void> {
  const pid = proc.child.pid
  if (!pid) return
  if (proc.group && process.platform !== 'win32' && trySignal(-pid, 'SIGTERM')) {
    const t = setTimeout(() => {
      if (trySignal(-pid, 0)) trySignal(-pid, 'SIGKILL')
    }, graceMs)
    t.unref()
    return
  }
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return
  const tree = [...(await descendantsOf(pid)), pid]
  for (const p of tree) trySignal(p, 'SIGTERM')
  const t = setTimeout(() => {
    for (const p of tree) if (trySignal(p, 0)) trySignal(p, 'SIGKILL')
  }, graceMs)
  t.unref()
}

function probeOne(p: string, mode: 'read' | 'list' | 'write'): ProbeResult {
  try {
    if (mode === 'read') {
      fs.closeSync(fs.openSync(p, fs.constants.O_RDONLY | O_NONBLOCK))
    } else if (mode === 'list') {
      fs.readdirSync(p)
    } else {
      const name = `.clawboo-probe-${crypto.randomBytes(6).toString('hex')}`
      const file = path.join(p, name)
      fs.writeFileSync(file, 'probe', { flag: 'wx', mode: 0o600 })
      try {
        if (fs.readFileSync(file, 'utf8') !== 'probe' || !fs.readdirSync(p).includes(name)) {
          return { path: p, mode, ok: false, code: 'EMISMATCH' }
        }
      } finally {
        fs.rmSync(file, { force: true })
      }
    }
    return { path: p, mode, ok: true }
  } catch (err) {
    return { path: p, mode, ok: false, code: errorCode(err) }
  }
}

function readText(p: string, max: number): { ok: boolean; code?: string; text?: string } {
  try {
    // /proc files report size 0, so read until the end rather than by fstat.
    const fd = fs.openSync(p, fs.constants.O_RDONLY | O_NONBLOCK)
    try {
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const b = Buffer.alloc(64 * 1024)
        const n = fs.readSync(fd, b, 0, b.length, null)
        if (n === 0) break
        chunks.push(b.subarray(0, n))
        total += n
        if (total >= max) break
      }
      return {
        ok: true,
        text: Buffer.concat(chunks).subarray(0, max).toString('utf8').replace(/\0/g, '\n'),
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return { ok: false, code: errorCode(err) }
  }
}

function runCheck(
  cmd: string,
  args: string[],
): Promise<{
  ran: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  code?: string
}> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: 10_000,
        maxBuffer: CHECK_OUTPUT_CHARS * 4,
        env: childEnvFor({
          PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
          LC_ALL: 'C',
        }),
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown }) | null
        if (e && typeof e.code === 'string') {
          return resolve({ ran: false, exitCode: null, stdout: '', stderr: '', code: e.code })
        }
        resolve({
          ran: true,
          exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: String(stdout).slice(0, CHECK_OUTPUT_CHARS),
          stderr: String(stderr).slice(0, CHECK_OUTPUT_CHARS),
        })
      },
    )
  })
}

/** Every regular file under `root` (one filesystem, links not followed) that is
 *  one of `targets`: a hard link to the database or the key, for instance. */
/** Let other requests (a ping above all) run between slices of a long job:
 *  a host that misses pings for 5 seconds is taken for dead, and the server
 *  stops every agent process. */
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

async function findInodes(
  root: string,
  targets: InodeRef[],
  maxEntries: number,
): Promise<{ matches: string[]; privileged: string[]; truncated: boolean }> {
  const want = new Set(targets.map((t) => `${t.dev}:${t.ino}`))
  const matches: string[] = []
  const privileged: string[] = []
  const me = typeof process.getuid === 'function' ? BigInt(process.getuid()) : -1n
  let seen = 0
  let rootDev: bigint
  try {
    rootDev = (await fs.promises.lstat(root, { bigint: true })).dev
  } catch {
    return { matches, privileged, truncated: false }
  }
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let names: string[]
    try {
      names = await fs.promises.readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (++seen > maxEntries) return { matches, privileged, truncated: true }
      if (seen % 512 === 0) await yieldNow()
      const p = path.join(dir, name)
      let st: fs.BigIntStats
      try {
        st = await fs.promises.lstat(p, { bigint: true })
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (st.dev === rootDev) stack.push(p)
      } else if (st.isFile()) {
        if (
          st.nlink > 1n &&
          want.has(`${st.dev}:${st.ino}`) &&
          matches.length < MAX_SEARCH_MATCHES
        ) {
          matches.push(p)
        }
        // setuid (04000) or setgid (02000), owned by anyone but this user.
        if ((st.mode & 0o6000n) !== 0n && st.uid !== me && privileged.length < MAX_SEARCH_MATCHES) {
          privileged.push(p)
        }
      }
    }
  }
  return { matches, privileged, truncated: false }
}

/** A folder's entries without following links, without blocking the host. */
async function listDirAsync(
  dir: string,
  max: number,
): Promise<{ entries: FsEntry[]; truncated: boolean }> {
  const names = (await fs.promises.readdir(dir)).sort()
  const entries: FsEntry[] = []
  let chars = 0
  for (const [i, name] of names.slice(0, max).entries()) {
    if (i % 512 === 511) await yieldNow()
    // The reply is one line; past the budget, stop and say so rather than send
    // a line the server would refuse as too long (and drop the connection).
    chars += name.length * 2 + 96
    if (chars > MAX_LIST_REPLY_CHARS) return { entries, truncated: true }
    try {
      const st = await fs.promises.lstat(path.join(dir, name))
      entries.push({ name, type: statType(st), size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return { entries, truncated: names.length > max }
}

export interface HostConnection {
  /** Stop every process this connection started. */
  close(): void
}

/**
 * Serve one server connection: read requests from `input`, answer on `output`.
 *
 * When `input` ends, every process this connection started is stopped, so a
 * server that went away does not leave its agents running.
 */
export function serveConnection(
  input: Readable,
  output: Writable,
  opts: { onEnd?: () => void } = {},
): HostConnection {
  const procs = new Map<string, Proc>()
  /** Paused because the connection to the server is congested. */
  const paused = new Set<Readable>()
  /** Paused because the server's buffer for that process is full. */
  const heldByServer = new Set<Readable>()
  let ended = false

  const send = (frame: HostToServerFrame): void => {
    if (ended) return
    const ok = output.write(encodeFrame(frame))
    if (!ok) {
      // The server is reading slower than the children write. Hold their output
      // until it catches up rather than buffer it all here.
      for (const p of procs.values()) {
        for (const s of [p.child.stdout, p.child.stderr]) {
          if (s && !s.isPaused()) {
            s.pause()
            paused.add(s)
          }
        }
      }
    }
  }
  output.on('drain', () => {
    for (const s of paused) if (!heldByServer.has(s)) s.resume()
    paused.clear()
  })
  output.on('error', () => {
    /* the server went away; `end` below cleans up */
  })

  const hello: HelloFrame = { t: 'hello', v: AGENT_HOST_PROTOCOL_VERSION, ...hostIdentity() }
  send(hello)

  const reply = (id: number, body: Record<string, unknown>): void => {
    send({ t: 'res', id, ok: true, ...body })
  }
  const fail = (id: number, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    send({ t: 'res', id, ok: false, code: errorCode(err), message: message.slice(0, 2000) })
  }

  const stopAll = (): void => {
    for (const p of procs.values()) void killTree(p, 3_000)
  }

  const handleSpawn = (id: number, f: Record<string, unknown>): void => {
    const proc = String(f['proc'] ?? '')
    if (!proc || procs.has(proc))
      return fail(id, Object.assign(new Error('bad process id'), { code: 'EINVAL' }))
    const stdio = (Array.isArray(f['stdio']) ? f['stdio'] : ['ignore', 'pipe', 'pipe']).map((m) =>
      m === 'pipe' ? 'pipe' : 'ignore',
    ) as [StdioMode, StdioMode, StdioMode]
    const group = f['group'] === true && process.platform !== 'win32'
    const args = Array.isArray(f['args']) ? f['args'].map(String) : []
    const env = f['env'] && typeof f['env'] === 'object' ? (f['env'] as Record<string, string>) : {}
    let child: ChildProcess
    try {
      child = spawn(String(f['command'] ?? ''), args, {
        // An empty folder name fails the spawn, as it does for Node's own
        // spawn: never the host's own folder instead.
        cwd: typeof f['cwd'] === 'string' ? f['cwd'] : undefined,
        env: childEnvFor(env),
        stdio,
        detached: group,
        shell: false,
        windowsHide: true,
      })
    } catch (err) {
      return fail(id, err)
    }
    if (!child.pid) {
      // Node reports a failed spawn (no such program, a missing cwd) as an
      // 'error' after this call returns.
      child.once('error', (err) => fail(id, err))
      return
    }
    const entry: Proc = { child, group }
    procs.set(proc, entry)
    reply(id, { pid: child.pid })
    child.stdout?.on('data', (d: Buffer) =>
      send({ t: 'ev', proc, ev: 'out', data: d.toString('base64') }),
    )
    child.stderr?.on('data', (d: Buffer) =>
      send({ t: 'ev', proc, ev: 'err', data: d.toString('base64') }),
    )
    child.stdin?.on('error', () => {
      /* a child that exits before reading its input */
    })
    child.on('error', (err) =>
      send({ t: 'ev', proc, ev: 'error', code: errorCode(err), message: err.message }),
    )
    child.on('exit', (code, signal) => send({ t: 'ev', proc, ev: 'exit', code, signal }))
    child.on('close', (code, signal) => {
      procs.delete(proc)
      send({ t: 'ev', proc, ev: 'close', code, signal })
    })
  }

  const handle = async (f: Record<string, unknown>): Promise<void> => {
    if (f['t'] === 'pause' || f['t'] === 'resume') {
      // The server's buffer for this process's output is full (or drained):
      // hold the child, as a full pipe would.
      const p = procs.get(String(f['proc'] ?? ''))
      for (const st of [p?.child.stdout, p?.child.stderr]) {
        if (!st) continue
        if (f['t'] === 'pause') {
          heldByServer.add(st)
          st.pause()
        } else {
          heldByServer.delete(st)
          if (!paused.has(st)) st.resume()
        }
      }
      return
    }
    if (f['t'] === 'in' || f['t'] === 'in-end') {
      const p = procs.get(String(f['proc'] ?? ''))
      if (!p?.child.stdin) return
      if (f['t'] === 'in-end') p.child.stdin.end()
      else p.child.stdin.write(Buffer.from(String(f['data'] ?? ''), 'base64'))
      return
    }
    if (f['t'] !== 'req' || typeof f['id'] !== 'number') return
    const id = f['id']
    try {
      switch (f['op']) {
        case 'ping':
          return reply(id, {})
        case 'spawn':
          return handleSpawn(id, f)
        case 'signal': {
          const p = procs.get(String(f['proc'] ?? ''))
          const sig = String(f['signal'] ?? 'SIGTERM')
          if (!SIGNALS.has(sig))
            throw Object.assign(new Error(`signal ${sig} not allowed`), { code: 'EINVAL' })
          return reply(id, { delivered: p ? p.child.kill(sig as NodeJS.Signals) : false })
        }
        case 'killTree': {
          const p = procs.get(String(f['proc'] ?? ''))
          const grace = Number(f['graceMs'])
          if (p)
            await killTree(
              p,
              Number.isFinite(grace) && grace >= 0 ? Math.min(grace, 60_000) : 3_000,
            )
          return reply(id, {})
        }
        case 'fs.read': {
          const max = Number(f['maxBytes'])
          const off = Number(f['offset'])
          try {
            const r = readBounded(
              String(f['path']),
              Number.isFinite(max) && max >= 0 ? max : MAX_READ_BYTES,
              Number.isInteger(off) && off > 0 ? off : 0,
            )
            return reply(id, {
              missing: false,
              data: r.data.toString('base64'),
              size: r.size,
              truncated: r.truncated,
            })
          } catch (err) {
            if (errorCode(err) === 'ENOENT') return reply(id, { missing: true })
            throw err
          }
        }
        case 'fs.write': {
          const data = Buffer.from(String(f['data'] ?? ''), 'base64')
          if (data.length > MAX_WRITE_BYTES)
            throw Object.assign(new Error('write too large'), { code: 'EFBIG' })
          writeAtomic(String(f['path']), data, Number(f['mode']) & 0o777)
          return reply(id, {})
        }
        case 'fs.append': {
          const data = Buffer.from(String(f['data'] ?? ''), 'base64')
          if (data.length > MAX_WRITE_BYTES)
            throw Object.assign(new Error('write too large'), { code: 'EFBIG' })
          appendNoFollow(String(f['path']), data, Number(f['mode']) & 0o777)
          return reply(id, {})
        }
        case 'fs.mkdir':
          mkdirMode(String(f['path']), Number(f['mode']) & 0o777)
          return reply(id, {})
        case 'fs.rm':
          await fs.promises.rm(String(f['path']), { recursive: true, force: true })
          return reply(id, {})
        case 'fs.rmdir': {
          const target = String(f['path'])
          // rmdir on a link fails with ENOTDIR on Linux and removes nothing; the
          // lstat makes that the same everywhere.
          if (!(await fs.promises.lstat(target)).isDirectory()) {
            throw Object.assign(new Error(`${target} is not a folder`), { code: 'ENOTDIR' })
          }
          await fs.promises.rmdir(target)
          return reply(id, {})
        }
        case 'fs.rename':
          fs.renameSync(String(f['from']), String(f['to']))
          return reply(id, {})
        case 'fs.realpath':
          return reply(id, { path: fs.realpathSync.native(String(f['path'])) })
        case 'fs.stat': {
          try {
            return reply(id, { stat: toStat(fs.lstatSync(String(f['path']))) })
          } catch (err) {
            if (errorCode(err) === 'ENOENT') return reply(id, { stat: null })
            throw err
          }
        }
        case 'fs.list': {
          const max = Math.max(0, Math.min(Number(f['max']) || 0, 100_000))
          return reply(id, await listDirAsync(String(f['path']), max))
        }
        case 'probe': {
          const checks = Array.isArray(f['checks']) ? f['checks'] : []
          const results = checks.map((c: { path?: unknown; mode?: unknown }) =>
            probeOne(String(c.path), c.mode === 'list' || c.mode === 'write' ? c.mode : 'read'),
          )
          return reply(id, { results })
        }
        case 'procView': {
          const pid = Number(f['pid'])
          if (!Number.isInteger(pid) || pid <= 0)
            throw Object.assign(new Error('bad pid'), { code: 'EINVAL' })
          if (process.platform === 'linux') {
            return reply(id, {
              environ: readText(`/proc/${pid}/environ`, 1024 * 1024),
              cmdline: readText(`/proc/${pid}/cmdline`, 256 * 1024),
              psEnv: { ok: false, code: 'ENOTSUP' },
            })
          }
          const cmd = await runCheck('ps', ['-ww', '-o', 'command=', '-p', String(pid)])
          const env = await runCheck('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)])
          return reply(id, {
            environ: { ok: false, code: 'ENOTSUP' },
            cmdline: cmd.ran
              ? { ok: cmd.exitCode === 0, text: cmd.stdout }
              : { ok: false, code: cmd.code },
            psEnv: env.ran
              ? { ok: env.exitCode === 0, text: env.stdout }
              : { ok: false, code: env.code },
          })
        }
        case 'inodes': {
          const targets = Array.isArray(f['targets']) ? (f['targets'] as InodeRef[]) : []
          const max = Math.max(1, Math.min(Number(f['maxEntries']) || 200_000, 2_000_000))
          return reply(id, await findInodes(String(f['root']), targets, max))
        }
        case 'privCheck': {
          const server = String(f['serverUser'] ?? '')
          const tries: [string, string, string[]][] = [
            ['sudo', 'sudo', ['-n', 'true']],
            ['doas', 'doas', ['-n', 'true']],
          ]
          if (/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(server)) {
            tries.push([`sudo -u ${server}`, 'sudo', ['-n', '-u', server, 'true']])
            tries.push([`doas -u ${server}`, 'doas', ['-n', '-u', server, 'true']])
          }
          const attempts = []
          for (const [what, cmd, args] of tries) {
            const r = await runCheck(cmd, args)
            attempts.push({ what, ran: r.ran, succeeded: r.ran && r.exitCode === 0 })
          }
          const cron = await runCheck('crontab', ['-l'])
          const crontab = !cron.ran
            ? 'absent'
            : /not allowed|permission denied|not permitted/i.test(cron.stderr + cron.stdout)
              ? 'denied'
              : 'allowed'
          return reply(id, { attempts, crontab })
        }
        case 'canExec': {
          const paths = Array.isArray(f['paths']) ? f['paths'].map(String) : []
          const results = paths.map((p) => {
            try {
              fs.accessSync(p, fs.constants.X_OK)
              const st = fs.statSync(p)
              if (!st.isFile()) return { path: p, ok: false, code: 'ENOTFILE' }
              return { path: p, ok: true }
            } catch (err) {
              return { path: p, ok: false, code: errorCode(err) }
            }
          })
          return reply(id, { results })
        }
        default:
          throw Object.assign(new Error(`unknown op ${String(f['op'])}`), { code: 'ENOSYS' })
      }
    } catch (err) {
      fail(id, err)
    }
  }

  input.setEncoding('utf8')
  const split = createLineSplitter(
    (line) => {
      const f = parseFrame(line)
      if (f) void handle(f)
    },
    () => input.destroy(),
  )
  input.on('data', (chunk: string) => split(chunk))
  const end = (): void => {
    if (ended) return
    stopAll()
    ended = true
    opts.onEnd?.()
  }
  input.on('end', end)
  input.on('close', end)
  input.on('error', end)

  return { close: end }
}
