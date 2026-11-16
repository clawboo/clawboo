// A stop asked for while the server was starting runs as soon as the stop is
// installed, and raises SIGTERM then. When an agent run keeps the shutdown
// waiting, the listen can complete during that wait. Whatever the server starts
// once it listens (the routines ticker first: it ends its own work on SIGTERM)
// would then start after the signal it needed, and claim due routines on a
// server that is going away. The real subprocess registry gives the shutdown
// its wait and its flag here; a fresh copy per test keeps the flag apart.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../platform', async (orig) => ({ ...(await orig()), isWindows: false }))

/** A process with an IPC channel. */
function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    send: () => boolean
    connected: boolean
    channel: { unref: () => void }
  }
  proc.send = () => true
  proc.connected = true
  proc.channel = { unref: () => undefined }
  return proc
}

/** A run still going: no pid (so nothing real is signalled) and no close yet. */
function runningChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: undefined
    exitCode: number | null
    signalCode: null
    kill: () => boolean
  }
  child.pid = undefined
  child.exitCode = null
  child.signalCode = null
  child.kill = () => true
  return child
}

async function freshModules() {
  vi.resetModules()
  const stop = await import('../serverStop')
  const subprocess = await import('../runtimes/subprocess')
  return { ...stop, ...subprocess }
}

describe('what the server starts once it listens', () => {
  let home: string
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-stop-listen-')))
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAWBOO_HOME', path.join(home, '.clawboo'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('starts when no stop has begun', async () => {
    const m = await freshModules()
    const start = vi.fn()
    m.startOnceListening(m.isSubprocessShutdown, start)()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('does not start for a stop queued before the listen, while shutdown still waits on a run', async () => {
    const m = await freshModules()
    const proc = fakeProcess()
    const channel = m.watchEmbedderChannel(proc, {})
    // Asked for while the server starts: held until the stop is installed.
    proc.emit('message', { type: 'shutdown' })

    const run = runningChild()
    m.registerRuntimeChild(run as never)

    // The ticker as startRoutinesTicker wires it: it stops on SIGTERM.
    const tickerStarted = vi.fn()
    const tickerStopped = vi.fn()
    const onListening = m.startOnceListening(m.isSubprocessShutdown, () => {
      tickerStarted()
      proc.once('SIGTERM', tickerStopped)
    })

    const exit = vi.fn<(code: number) => void>()
    m.installServerStop({
      proc,
      channel,
      gracefulExit: async () => {
        await m.shutdownLiveSubprocesses(2_000)
      },
      exit,
    })
    // The stop has begun and waits on the run; the listen completes now.
    expect(exit).not.toHaveBeenCalled()
    onListening()
    expect(tickerStarted).not.toHaveBeenCalled()

    // The run ends; the stop finishes as before.
    run.exitCode = 0
    run.emit('close', 0, null)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(tickerStopped).not.toHaveBeenCalled()
  })

  it('no after-listen start runs for a stop kept during boot, though the server already listens', async () => {
    // A boot that moves work folders listens early, so /api/health can say
    // `migrating`; the after-listen starts then ran BEFORE the stop was
    // installed, and a stop kept during the move fired only after the routines
    // ticker had resumed and ticked.
    for (const kept of ['message', 'SIGTERM'] as const) {
      const m = await freshModules()
      const proc = fakeProcess()
      const channel = m.watchEmbedderChannel(proc, {})
      const signals = m.watchStopSignals(proc)
      if (kept === 'message') proc.emit('message', { type: 'shutdown' })
      else proc.emit('SIGTERM')

      const afterListen = vi.fn()
      const listen = vi.fn()
      const gracefulExit = vi.fn(async () => undefined)
      const exit = vi.fn<(code: number) => void>()
      const stop = m.installStopThenListen(
        { proc, signals, channel, gracefulExit, exit },
        { listening: true, listen, onListening: afterListen },
      )
      expect(stop.stopping()).toBe(true)
      expect(gracefulExit).toHaveBeenCalledTimes(1)
      expect(afterListen).not.toHaveBeenCalled()
      expect(listen).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    }
  })

  it('a server not yet listening does not start to listen for a kept stop', async () => {
    const m = await freshModules()
    const proc = fakeProcess()
    const signals = m.watchStopSignals(proc)
    proc.emit('SIGINT')
    const listen = vi.fn()
    m.installStopThenListen(
      {
        proc,
        signals,
        channel: m.watchEmbedderChannel(proc, {}),
        gracefulExit: async () => undefined,
        exit: () => undefined,
      },
      { listening: false, listen, onListening: vi.fn() },
    )
    expect(listen).not.toHaveBeenCalled()
  })

  it('with no stop, starts once listening, and not for a stop asked while the listen completes', async () => {
    const m = await freshModules()
    const proc = fakeProcess()
    const deps = {
      proc,
      signals: m.watchStopSignals(proc),
      channel: m.watchEmbedderChannel(proc, {}),
      gracefulExit: async () => undefined,
      exit: () => undefined,
    }
    const now = vi.fn()
    m.installStopThenListen(deps, { listening: true, listen: vi.fn(), onListening: now })
    expect(now).toHaveBeenCalledTimes(1)

    const m2 = await freshModules()
    const proc2 = fakeProcess()
    let complete: () => void = () => {}
    const later = vi.fn()
    m2.installStopThenListen(
      {
        proc: proc2,
        signals: m2.watchStopSignals(proc2),
        channel: m2.watchEmbedderChannel(proc2, {}),
        gracefulExit: async () => undefined,
        exit: () => undefined,
      },
      {
        listening: false,
        listen: (onListening) => {
          complete = onListening
        },
        onListening: later,
      },
    )
    proc2.emit('SIGTERM')
    complete()
    expect(later).not.toHaveBeenCalled()
  })

  it('is how the server installs its stop: before anything it starts once it listens', () => {
    // On the order before this, `if (server.listening) onListening()` ran ahead
    // of `installServerStop(...)`.
    const source = fs.readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8')
    const install = source.indexOf('installStopThenListen(')
    expect(install).toBeGreaterThan(-1)
    expect(source.indexOf('installStopThenListen(', install + 1)).toBe(-1)
    // The after-listen starts are handed to it, never called or listened for
    // anywhere else.
    expect(source).not.toMatch(/startAfterListen\(\)/)
    expect(source).not.toMatch(/\bonListening\(\)/)
    expect(source).not.toMatch(/installServerStop\(|startOnceListening\(/)
    expect(source).toMatch(/onListening: startAfterListen/)
    // Signals are watched from the start of boot, and kept for the stop.
    expect(source.indexOf('watchStopSignals(process)')).toBeGreaterThan(-1)
    expect(source.indexOf('watchStopSignals(process)')).toBeLessThan(install)
  })
})
