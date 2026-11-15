// How the server is asked to stop: a signal, or the app that started it, over
// its IPC channel. The unit cases drive the two functions through a stand-in
// process. The process cases fork real Node processes: one the way an app does
// (it keeps the channel and sends the shutdown message), and one the way the
// `clawboo` launcher does (it lets go of the channel and exits), because a
// server that stopped whenever its channel closed would die the moment the
// launcher returned.

import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { killProcessTreeByPid } from '../runtimes/killTree'
import {
  STOP_ON_DISCONNECT_ENV,
  installServerStop,
  isShutdownMessage,
  watchEmbedderChannel,
  type ChannelStopReason,
} from '../serverStop'

const MODULE_TS = path.resolve(__dirname, '../serverStop.ts')
// tsx loads the TypeScript module into the plain Node processes below.
const TSX_API = createRequire(import.meta.url).resolve('tsx/esm/api')
// Where the real processes below run: never inside a folder a test removes. On
// Windows a process's working directory is an open handle that blocks removing
// the folder, held for as long as any process started there lives, tsx's own
// helper processes included, and a pid can read as gone before it is released.
const RUN_DIR = fs.realpathSync(os.tmpdir())

/** A process with an IPC channel, or without one when `send` is left out. */
function fakeProcess(opts: { channel?: boolean; connected?: boolean } = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    send?: unknown
    connected?: boolean
    channel?: { unref: () => void }
  }
  if (opts.channel !== false) {
    proc.send = () => true
    proc.connected = opts.connected ?? true
    proc.channel = { unref: vi.fn() }
  }
  return proc
}

describe('isShutdownMessage', () => {
  it('takes { type: "shutdown" } and nothing else', () => {
    expect(isShutdownMessage({ type: 'shutdown' })).toBe(true)
    expect(isShutdownMessage({ type: 'shutdown', reason: 'quit' })).toBe(true)
    for (const other of [
      null,
      undefined,
      'shutdown',
      { type: 'Shutdown' },
      { type: 'set-path', path: '/usr/bin' },
      { kind: 'shutdown' },
      ['shutdown'],
    ]) {
      expect(isShutdownMessage(other)).toBe(false)
    }
  })
})

describe('watchEmbedderChannel', () => {
  it('stops on the shutdown message, and ignores every other message', () => {
    const proc = fakeProcess()
    const channel = watchEmbedderChannel(proc, {})
    const stop = vi.fn<(reason: ChannelStopReason) => void>()
    channel.onStop(stop)

    proc.emit('message', { type: 'set-path', path: '/usr/bin' })
    proc.emit('message', 'shutdown')
    expect(stop).not.toHaveBeenCalled()

    proc.emit('message', { type: 'shutdown' })
    expect(stop).toHaveBeenCalledWith('message')
  })

  it('holds a stop asked for while the server starts, and runs it once', () => {
    const proc = fakeProcess()
    const channel = watchEmbedderChannel(proc, {})
    proc.emit('message', { type: 'shutdown' })
    proc.emit('message', { type: 'shutdown' })

    const stop = vi.fn<(reason: ChannelStopReason) => void>()
    channel.onStop(stop)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith('message')
  })

  it('keeps running when the channel closes, unless the app asked otherwise', () => {
    const proc = fakeProcess()
    const channel = watchEmbedderChannel(proc, {})
    const stop = vi.fn()
    channel.onStop(stop)

    proc.connected = false
    proc.emit('disconnect')
    expect(stop).not.toHaveBeenCalled()
    expect(channel.stopOnDisconnect).toBe(false)
    // Not even a listener: the launcher's server pays nothing for the option.
    expect(proc.listenerCount('disconnect')).toBe(0)
  })

  it('stops when the channel closes with CLAWBOO_STOP_ON_DISCONNECT=1', () => {
    const proc = fakeProcess()
    const channel = watchEmbedderChannel(proc, { [STOP_ON_DISCONNECT_ENV]: '1' })
    expect(channel.stopOnDisconnect).toBe(true)
    const stop = vi.fn()
    channel.onStop(stop)

    proc.connected = false
    proc.emit('disconnect')
    expect(stop).toHaveBeenCalledWith('disconnect')
  })

  it('stops for a channel that had already closed when the server started', () => {
    const proc = fakeProcess({ connected: false })
    const channel = watchEmbedderChannel(proc, { [STOP_ON_DISCONNECT_ENV]: '1' })
    const stop = vi.fn()
    channel.onStop(stop)
    expect(stop).toHaveBeenCalledWith('disconnect')
  })

  it('takes only 1 as asking for it', () => {
    for (const value of ['true', 'yes', '0', '', ' 1']) {
      const proc = fakeProcess()
      const channel = watchEmbedderChannel(proc, { [STOP_ON_DISCONNECT_ENV]: value })
      const stop = vi.fn()
      channel.onStop(stop)
      proc.emit('disconnect')
      expect(stop, `value ${JSON.stringify(value)}`).not.toHaveBeenCalled()
    }
  })

  it('takes the variable out of the environment, so nothing the server starts inherits it', () => {
    const env: NodeJS.ProcessEnv = { [STOP_ON_DISCONNECT_ENV]: '1', KEEP: 'me' }
    watchEmbedderChannel(fakeProcess(), env)
    expect(env).toEqual({ KEEP: 'me' })

    const without: NodeJS.ProcessEnv = { [STOP_ON_DISCONNECT_ENV]: '1' }
    watchEmbedderChannel(fakeProcess({ channel: false }), without)
    expect(without).toEqual({})
  })

  it('lets go of the channel, so the listeners never keep a failed start alive', () => {
    const proc = fakeProcess()
    watchEmbedderChannel(proc, { [STOP_ON_DISCONNECT_ENV]: '1' })
    expect(proc.channel?.unref).toHaveBeenCalledTimes(1)
  })

  it('listens to nothing without a channel', () => {
    const proc = fakeProcess({ channel: false })
    const channel = watchEmbedderChannel(proc, { [STOP_ON_DISCONNECT_ENV]: '1' })
    expect(channel.hasChannel).toBe(false)
    expect(channel.stopOnDisconnect).toBe(false)
    expect(proc.listenerCount('message')).toBe(0)
    expect(proc.listenerCount('disconnect')).toBe(0)
  })
})

describe('installServerStop', () => {
  function setup() {
    const proc = fakeProcess()
    const channel = watchEmbedderChannel(proc, { [STOP_ON_DISCONNECT_ENV]: '1' })
    let finish: () => void = () => {}
    const gracefulExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const exit = vi.fn<(code: number) => void>()
    const onStopping = vi.fn<(why: string) => void>()
    installServerStop({ proc, channel, gracefulExit, exit, onStopping })
    return { proc, gracefulExit, exit, onStopping, finish: () => finish() }
  }

  it('stops on the shutdown message exactly as on SIGTERM, then exits 0', async () => {
    for (const ask of ['message', 'SIGTERM'] as const) {
      const s = setup()
      if (ask === 'message') s.proc.emit('message', { type: 'shutdown' })
      else s.proc.emit('SIGTERM')
      expect(s.gracefulExit).toHaveBeenCalledTimes(1)
      // Not before the runs have ended and the database is closed.
      expect(s.exit).not.toHaveBeenCalled()
      s.finish()
      await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(0))
    }
  })

  it('runs once when asked several ways (a wrapper that also raises SIGTERM)', async () => {
    const s = setup()
    s.proc.emit('message', { type: 'shutdown' })
    s.proc.emit('SIGTERM')
    s.proc.emit('SIGINT')
    s.proc.connected = false
    s.proc.emit('disconnect')
    expect(s.gracefulExit).toHaveBeenCalledTimes(1)
    expect(s.onStopping).toHaveBeenCalledTimes(1)
    expect(s.onStopping).toHaveBeenCalledWith('shutdown message')
    s.finish()
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledTimes(1))
  })

  it('raises SIGTERM for the parts that end their own work on it', async () => {
    for (const ask of ['message', 'disconnect'] as const) {
      const s = setup()
      // Registered after the stop, as the routines ticker is.
      const ticker = vi.fn()
      s.proc.once('SIGTERM', ticker)
      if (ask === 'message') s.proc.emit('message', { type: 'shutdown' })
      else {
        s.proc.connected = false
        s.proc.emit('disconnect')
      }
      expect(ticker).toHaveBeenCalledTimes(1)
      expect(s.gracefulExit).toHaveBeenCalledTimes(1)
      expect(s.onStopping).toHaveBeenCalledWith(
        ask === 'message' ? 'shutdown message' : 'the IPC channel closed',
      )
    }
  })

  it('says why it stops', () => {
    const viaSignal = setup()
    viaSignal.proc.emit('SIGINT')
    expect(viaSignal.onStopping).toHaveBeenCalledWith('SIGINT')

    const viaClose = setup()
    viaClose.proc.connected = false
    viaClose.proc.emit('disconnect')
    expect(viaClose.onStopping).toHaveBeenCalledWith('the IPC channel closed')
  })

  it('leaves a second Ctrl+C to end the process at once', () => {
    const s = setup()
    s.proc.emit('SIGINT')
    // `once`: no handler is left, so Node's default (exit now) applies again.
    expect(s.proc.listenerCount('SIGINT')).toBe(0)
  })

  it('exits 0 even when the graceful part fails', async () => {
    const proc = fakeProcess()
    const exit = vi.fn<(code: number) => void>()
    installServerStop({
      proc,
      channel: watchEmbedderChannel(proc, {}),
      gracefulExit: () => Promise.reject(new Error('boom')),
      exit,
    })
    proc.emit('message', { type: 'shutdown' })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })
})

// ── Real processes ───────────────────────────────────────────────────────────

interface Line {
  event: string
  [key: string]: unknown
}

function readLines(file: string): Line[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
}

async function waitForLine(file: string, event: string, timeoutMs = 30_000): Promise<Line> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const line = readLines(file).find((l) => l.event === event)
    if (line) return line
    if (Date.now() > until) throw new Error(`no "${event}" line in ${file}: ${readLines(file)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The process runs outside the test's folder, so it never blocks removing it. */
function expectOutside(root: string, ready: Line): void {
  const rel = path.relative(root, String(ready['cwd']))
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  expect(inside, `runs in ${String(ready['cwd'])}`).toBe(false)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('real processes', () => {
  const made: string[] = []
  const pids: number[] = []
  const children: ChildProcess[] = []
  // A child still running holds its working directory, which Windows will not
  // delete, so each one is waited for before its folder goes.
  afterEach(async () => {
    await Promise.all(
      children.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve()
            child.once('exit', () => resolve())
            child.kill('SIGKILL')
          }),
      ),
    )
    // A detached server is no child of this process: its whole tree goes.
    for (const pid of pids.splice(0)) {
      if (!alive(pid)) continue
      killProcessTreeByPid(pid, { graceMs: 0 })
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
    }
    for (const dir of made.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  /** A server stand-in: the real module, with a graceful part that only reports. */
  function setup(): { root: string; child: string; out: string; env: NodeJS.ProcessEnv } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-stop-')))
    made.push(root)
    const child = path.join(root, 'server.mjs')
    fs.writeFileSync(
      child,
      `
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const [tsxApi, moduleTs, out] = process.argv.slice(2)
const write = (o) => fs.appendFileSync(out, JSON.stringify(o) + '\\n')
const { register } = await import(pathToFileURL(tsxApi).href)
register()
const { installServerStop, watchEmbedderChannel } = await import(pathToFileURL(moduleTs).href)
const channel = watchEmbedderChannel(process, process.env)
installServerStop({
  proc: process,
  channel,
  gracefulExit: async () => write({ event: 'graceful' }),
  exit: (code) => {
    write({ event: 'exit', code })
    process.exit(code)
  },
  onStopping: (why) => write({ event: 'stopping', why }),
})
// Like the routines ticker and the approval reaper: a part of the server that
// ends its own work on SIGTERM, registered after the stop.
process.once('SIGTERM', () => write({ event: 'subsystem' }))
write({
  event: 'ready',
  pid: process.pid,
  stopOnDisconnect: channel.stopOnDisconnect,
  inherited: process.env.${STOP_ON_DISCONNECT_ENV} ?? null,
  cwd: process.cwd(),
})
// With a callback: a send to a launcher that has already gone reports to it
// instead of raising an 'error' event that would end this process.
if (process.connected) process.send({ type: 'ready' }, () => {})
setInterval(() => {}, 1000)
`,
    )
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAWBOO_HOME: path.join(home, '.clawboo'),
    }
    delete env[STOP_ON_DISCONNECT_ENV]
    return { root, child, out: path.join(root, 'out.jsonl'), env }
  }

  /** Starts the stand-in the way the `clawboo` launcher starts the bundled server
   *  (apps/cli/src/lifecycle.ts): fork, detached, then let go of the child and its
   *  channel and exit. `strip` drops the option from the server's env as the
   *  launcher does. Returns the server's pid. */
  function launch(
    s: ReturnType<typeof setup>,
    env: NodeJS.ProcessEnv,
    opts: { strip?: boolean } = {},
  ): number {
    const launcher = path.join(s.root, 'launcher.mjs')
    fs.writeFileSync(
      launcher,
      `
import { fork } from 'node:child_process'
const [mode, server, ...args] = process.argv.slice(2)
const env = mode === 'strip' ? { ...process.env, ${STOP_ON_DISCONNECT_ENV}: undefined } : process.env
const child = fork(server, args, { detached: true, stdio: 'ignore', env })
child.unref()
child.channel?.unref()
child.on('error', () => {})
console.log(child.pid)
`,
    )
    const mode = opts.strip ? 'strip' : 'keep'
    const run = spawnSync(process.execPath, [launcher, mode, s.child, TSX_API, MODULE_TS, s.out], {
      cwd: RUN_DIR,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(run.stderr).toBe('')
    // The launcher returns on its own, as `clawboo` must.
    expect(run.status).toBe(0)
    const pid = Number(run.stdout.trim())
    expect(Number.isInteger(pid)).toBe(true)
    pids.push(pid)
    return pid
  }

  /** Starts the stand-in the way an app does: it keeps the channel. */
  function start(s: ReturnType<typeof setup>, env: NodeJS.ProcessEnv): ChildProcess {
    const child = fork(s.child, [TSX_API, MODULE_TS, s.out], {
      cwd: RUN_DIR,
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.push(child)
    return child
  }

  const ready = (child: ChildProcess) =>
    new Promise<void>((resolve) =>
      child.on('message', (m) => {
        if ((m as { type?: string }).type === 'ready') resolve()
      }),
    )
  const exited = (child: ChildProcess) =>
    new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))

  it('a server the launcher starts outlives the launcher', async () => {
    const s = setup()
    const pid = launch(s, s.env)
    const line = await waitForLine(s.out, 'ready')
    expect(line['pid']).toBe(pid)
    expect(line['stopOnDisconnect']).toBe(false)
    expectOutside(s.root, line)
    // Its channel closed when the launcher exited; give a stop time to show.
    await new Promise((r) => setTimeout(r, 1500))
    expect(alive(pid)).toBe(true)
    expect(readLines(s.out).map((l) => l.event)).toEqual(['ready'])
  }, 60_000)

  it('outlives a launcher whose own shell has the option, once the launcher drops it', async () => {
    const s = setup()
    const pid = launch(s, { ...s.env, [STOP_ON_DISCONNECT_ENV]: '1' }, { strip: true })
    const line = await waitForLine(s.out, 'ready')
    expect(line['stopOnDisconnect']).toBe(false)
    expectOutside(s.root, line)
    await new Promise((r) => setTimeout(r, 1500))
    expect(alive(pid)).toBe(true)
    expect(readLines(s.out).map((l) => l.event)).toEqual(['ready'])
  }, 60_000)

  it('stops with its launcher when the app opted in, and hands the option to nobody', async () => {
    const s = setup()
    const pid = launch(s, { ...s.env, [STOP_ON_DISCONNECT_ENV]: '1' })
    const line = await waitForLine(s.out, 'ready')
    expect(line['stopOnDisconnect']).toBe(true)
    expect(line['inherited']).toBeNull()
    expect(await waitForLine(s.out, 'stopping')).toMatchObject({ why: 'the IPC channel closed' })
    expect(await waitForLine(s.out, 'exit')).toMatchObject({ code: 0 })
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
  }, 60_000)

  it('stops on the shutdown message, gracefully, with exit code 0', async () => {
    const s = setup()
    const child = start(s, s.env)
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    const done = exited(child)
    await ready(child)
    child.send({ type: 'shutdown' })
    expect(await done).toBe(0)
    expect(stderr).toBe('')
    // The parts that end their work on SIGTERM end it on the message too.
    expect(readLines(s.out).map((l) => l.event)).toEqual([
      'ready',
      'stopping',
      'graceful',
      'subsystem',
      'exit',
    ])
    expect(readLines(s.out)[1]).toMatchObject({ why: 'shutdown message' })
  }, 60_000)

  it('stops when an app that opted in closes the channel', async () => {
    const s = setup()
    const child = start(s, { ...s.env, [STOP_ON_DISCONNECT_ENV]: '1' })
    const done = exited(child)
    await ready(child)
    child.disconnect()
    expect(await done).toBe(0)
    expect(readLines(s.out)[1]).toMatchObject({ event: 'stopping', why: 'the IPC channel closed' })
    expect(readLines(s.out).map((l) => l.event)).toContain('subsystem')
  }, 60_000)

  it('keeps running when an app that did not opt in closes the channel', async () => {
    const s = setup()
    const child = start(s, s.env)
    await ready(child)
    child.disconnect()
    await new Promise((r) => setTimeout(r, 1500))
    expect(child.exitCode).toBeNull()
    expect(readLines(s.out).map((l) => l.event)).toEqual(['ready'])
  }, 60_000)

  it('a server that fails to start still exits while the app holds the channel', async () => {
    const s = setup()
    const failing = path.join(s.root, 'failing.mjs')
    fs.writeFileSync(
      failing,
      `
import { pathToFileURL } from 'node:url'
const [tsxApi, moduleTs] = process.argv.slice(2)
const { register } = await import(pathToFileURL(tsxApi).href)
register()
const { watchEmbedderChannel } = await import(pathToFileURL(moduleTs).href)
watchEmbedderChannel(process, process.env)
// As the server's main().catch does: report and let the process end.
process.exitCode = 1
`,
    )
    const child = fork(failing, [TSX_API, MODULE_TS], {
      cwd: RUN_DIR,
      env: s.env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.push(child)
    const end = await Promise.race([
      exited(child),
      new Promise<'still running'>((r) => setTimeout(() => r('still running'), 20_000)),
    ])
    expect(end).toBe(1)
  }, 60_000)

  // Windows has no SIGTERM to catch: a signal from another process ends the
  // process there, which is why the message exists.
  it.skipIf(process.platform === 'win32')(
    'stops on SIGTERM through the same stop',
    async () => {
      const s = setup()
      const child = start(s, s.env)
      const done = exited(child)
      await ready(child)
      child.kill('SIGTERM')
      expect(await done).toBe(0)
      expect(readLines(s.out).map((l) => l.event)).toEqual([
        'ready',
        'stopping',
        'graceful',
        'subsystem',
        'exit',
      ])
      expect(readLines(s.out)[1]).toMatchObject({ why: 'SIGTERM' })
    },
    60_000,
  )
})
