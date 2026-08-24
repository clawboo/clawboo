// A connector child must be reaped by the AWAITED shutdown path, not by the
// synchronous fallback that runs after it. The distinction is not academic: the
// fallback is followed immediately by process.exit(0), which kills the SIGKILL
// escalation timer with the process, so a child that ignores SIGTERM survives
// the server.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { killProcessTreeByPid } from '../../runtimes/killTree'

/**
 * A FRESH module per test.
 *
 * `shuttingDown` in subprocess.ts is a sticky module-level flag by design: once
 * shutdown begins it must never un-begin. That makes the module effectively
 * single-use, so without a reset these tests would be order-dependent -- each
 * one inheriting whatever state its predecessor left behind.
 */
type Subprocess = typeof import('../../runtimes/subprocess')
let mod: Subprocess
let stateDir: string
let prevClawbooHome: string | undefined

beforeEach(async () => {
  // SANDBOX THE STATE DIR. `unregisterConnectorPid` reaches the durable pid file
  // through `resolveClawbooDir`, so without this the suite writes into the
  // developer's real ~/.clawboo and can drop the record of a connector they
  // actually have running.
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-reap-'))
  prevClawbooHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = stateDir
  vi.resetModules()
  mod = await import('../../runtimes/subprocess')
})

const spawned: number[] = []

function spawnSleeper(): number {
  // detached, so the pid IS a process-group leader and the negative-pid signal
  // reaches the tree exactly as it does for a real connector.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const pid = child.pid
  if (!pid) throw new Error('no pid')
  spawned.push(pid)
  return pid
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  rmSync(stateDir, { recursive: true, force: true })
  // The SAME killer the product uses, not a hand-rolled negative-pid signal.
  // A process GROUP is a POSIX concept: on Windows `process.kill(-pid)` throws,
  // so every sleeper this file spawned outlived the run on that job.
  for (const pid of spawned.splice(0)) killProcessTreeByPid(pid)
})

describe('connector process reaping', () => {
  it('kills a registered connector child and WAITS for it to die', async () => {
    const pid = spawnSleeper()
    expect(alive(pid)).toBe(true)

    mod.registerConnectorPid(pid)
    const res = await mod.shutdownLiveSubprocesses(5_000)

    expect(res.signalled).toBeGreaterThanOrEqual(1)
    // The awaited path returns only once the process is actually gone, which is
    // what gives the escalation timer room to run.
    expect(alive(pid)).toBe(false)
  }, 15_000)

  it('kills a child that registers AFTER shutdown began', async () => {
    // Shutdown has already taken its snapshot, so a late registrant would
    // otherwise outlive the server entirely.
    await mod.shutdownLiveSubprocesses(100)
    const pid = spawnSleeper()
    mod.registerConnectorPid(pid)

    for (let i = 0; i < 100 && alive(pid); i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(alive(pid)).toBe(false)
  }, 15_000)

  it('stops tracking a connector that closed cleanly', async () => {
    // Asserted on the REGISTRY, not on process liveness: a signal races the
    // assertion, so "still alive after 200ms" would be a coin flip dressed up as
    // a test. `signalled` is the deterministic statement of what shutdown saw.
    const pid = spawnSleeper()
    mod.registerConnectorPid(pid)
    mod.unregisterConnectorPid(pid)
    const res = await mod.shutdownLiveSubprocesses(200)
    expect(res.signalled).toBe(0)
  }, 15_000)
})
