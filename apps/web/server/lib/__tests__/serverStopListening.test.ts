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

  it('is what the server wraps its listen callback in', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8')
    expect(source).toMatch(
      /const onListening = startOnceListening\(\s*isSubprocessShutdown,\s*\(\): void => \{/,
    )
  })
})
