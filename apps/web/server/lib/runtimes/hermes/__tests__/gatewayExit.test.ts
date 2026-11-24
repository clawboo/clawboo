// When the server stops, the Hermes gateway gets its planned stop: SIGINT to the
// gateway process, beside (not after) the wait for the other runtime children,
// and never the generic reap's SIGTERM, which Hermes 0.23.1 reads as a crash
// (it then exits 1 and records the gateway as still running). A server that
// never started a gateway waits for nothing.
//
// Real processes, no mocks of the registry or of killTree: a stand-in gateway
// that writes down every signal it gets. POSIX only: on Windows Node has no
// SIGINT to send, and the gateway's tree is killed there as before.

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const itPosix = process.platform === 'win32' ? it.skip : it

let dir: string
/** Stops for whatever a failed test left running, through its own handle, so
 *  no recycled pid is ever signalled. */
const leftovers: (() => unknown)[] = []

beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-hermes-exit-'))
  // Nothing here may reach the real ~/.clawboo.
  vi.stubEnv('HOME', dir)
  vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
  vi.stubEnv('CLAWBOO_AGENT_USER', '')
  vi.stubEnv('CLAWBOO_AGENT_USERS', '')
})

afterEach(async () => {
  for (const stop of leftovers.splice(0)) await stop()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type FakeMode = 'drain' | 'hang' | 'leave-child'

/** A stand-in for `hermes gateway run`: writes each signal down; drains for
 *  100 ms on SIGINT, or ignores every signal when told to hang. With
 *  `leave-child` it starts a child in the gateway's own process group that
 *  ignores signals (and gives up by itself after 20 s), and leaves it behind. */
function writeFakeHermes(mode: FakeMode): string {
  const script = path.join(dir, 'fake-hermes.mjs')
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const home = process.env.HERMES_HOME
if (${JSON.stringify(mode)} === 'leave-child') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 20000)"], { stdio: 'ignore' })
  writeFileSync(path.join(home, 'child'), String(child.pid))
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    appendFileSync(path.join(home, 'signals.log'), sig + '\\n')
    if (${JSON.stringify(mode)} === 'hang') return
    if (sig === 'SIGINT') setTimeout(() => process.exit(0), 100)
    else process.exit(1)
  })
}
writeFileSync(path.join(home, 'ready'), String(process.pid))
setInterval(() => {}, 1000)
`,
  )
  chmodSync(script, 0o755)
  return script
}

const signals = (): string[] => {
  const file = path.join(dir, 'gw', 'signals.log')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
}

/** Fresh modules for each test: the registry's shutdown flag never clears. */
async function load() {
  const subprocess = await import('../../subprocess')
  const gateway = await import('../gateway')
  const hermes = await import('../index')
  const exitStop = await import('../../exitStop')
  return { subprocess, gateway, hermes, exitStop }
}

/** A supervisor that runs the stand-in, healthy once it has its handlers. */
async function startGateway(mode: FakeMode) {
  const mods = await load()
  const script = writeFakeHermes(mode)
  const home = path.join(dir, 'gw')
  const ready = path.join(home, 'ready')
  const gw = new mods.gateway.HermesGatewaySupervisor({
    resolveCommand: () => script,
    home: () => home,
    preferredPort: () => 18642,
    isPortFree: async () => true,
    portOwner: async () => 'ours' as const,
    masterKey: () => 'k'.repeat(64),
    startTimeoutMs: 15_000,
    fetch: async (input) => {
      if (!existsSync(ready)) throw new TypeError('fetch failed')
      return String(input).endsWith('/health')
        ? new Response(JSON.stringify({ status: 'ok', version: '0.23.1' }))
        : new Response(JSON.stringify({ jobs: [] }))
    },
  })
  mods.hermes.setHermesGatewayForTests(gw)
  await gw.ensureRunning()
  const pid = gw.status().pid!
  leftovers.push(() => gw.stopForExit(0))
  expect(alive(pid)).toBe(true)
  return { ...mods, gw, pid }
}

describe('the Hermes gateway when the server stops', () => {
  itPosix('is left out of the generic reap, and gets SIGINT, not SIGTERM', async () => {
    const { subprocess, hermes, pid } = await startGateway('drain')

    // The reap every other runtime child gets: SIGTERM to the whole tree.
    const reap = await subprocess.shutdownLiveSubprocesses(500)
    expect(reap.signalled).toBe(0)
    expect(signals()).toEqual([])
    expect(alive(pid)).toBe(true)

    expect(await hermes.stopHermesGatewayForExit({ CLAWBOO_HERMES_STOP_GRACE_MS: '3000' })).toBe(
      'stopped',
    )
    expect(signals()).toEqual(['SIGINT'])
    expect(alive(pid)).toBe(false)
  })

  itPosix('leaves nothing it started behind once it has exited', async () => {
    const { hermes } = await startGateway('leave-child')
    const child = Number(readFileSync(path.join(dir, 'gw', 'child'), 'utf8'))
    expect(alive(child)).toBe(true)
    expect(await hermes.stopHermesGatewayForExit({ CLAWBOO_HERMES_STOP_GRACE_MS: '3000' })).toBe(
      'stopped',
    )
    expect(signals()).toEqual(['SIGINT'])
    for (let i = 0; i < 40 && alive(child); i++) await new Promise((r) => setTimeout(r, 25))
    expect(alive(child)).toBe(false)
  })

  itPosix('is killed once the grace runs out, with SIGINT first', async () => {
    const { hermes, pid } = await startGateway('hang')
    const t0 = Date.now()
    const outcome = await hermes.stopHermesGatewayForExit({ CLAWBOO_HERMES_STOP_GRACE_MS: '400' })
    const took = Date.now() - t0
    expect(outcome).toBe('killed')
    expect(took).toBeGreaterThanOrEqual(390)
    expect(took).toBeLessThan(2_500)
    expect(signals()[0]).toBe('SIGINT')
    expect(alive(pid)).toBe(false)
  })

  itPosix('is stopped beside the wait for other children, not after it', async () => {
    const { subprocess, exitStop, pid } = await startGateway('hang')
    // A runtime child that ignores SIGTERM: killTree's SIGKILL reaches it 3 s in.
    const stubborn: ChildProcess = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { detached: true, stdio: 'ignore' },
    )
    leftovers.push(() => stubborn.kill('SIGKILL'))
    subprocess.registerRuntimeChild(stubborn as never)
    await new Promise((r) => setTimeout(r, 300))

    const log = { info: vi.fn(), warn: vi.fn() }
    const t0 = Date.now()
    await exitStop.stopRuntimesForExit(log, {
      childWaitMs: 5_000,
      env: { CLAWBOO_HERMES_STOP_GRACE_MS: '2000' },
    })
    const took = Date.now() - t0
    // In turn this would be about 3 s for the child, then 2 s and the kill for
    // the gateway. Side by side it is the child's 3 s.
    expect(took).toBeLessThan(4_500)
    expect(alive(pid)).toBe(false)
    expect(alive(stubborn.pid!)).toBe(false)
    expect(signals()[0]).toBe('SIGINT')
    expect(log.info).toHaveBeenCalledWith(
      { outcome: 'killed' },
      'Stopped the Hermes gateway on shutdown',
    )
  })

  it('does nothing and waits for nothing when no gateway was ever started', async () => {
    const { hermes, exitStop } = await load()
    const t0 = performance.now()
    expect(await hermes.stopHermesGatewayForExit()).toBe('not-running')
    hermes.signalHermesGatewayForExit()
    const log = { info: vi.fn(), warn: vi.fn() }
    await exitStop.stopRuntimesForExit(log)
    expect(performance.now() - t0).toBeLessThan(100)
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('passes the grace from CLAWBOO_HERMES_STOP_GRACE_MS, capped at 8 s', async () => {
    const { hermes } = await load()
    const stopForExit = vi.fn(async () => 'stopped' as const)
    hermes.setHermesGatewayForTests({ stopForExit } as never)
    await hermes.stopHermesGatewayForExit({ CLAWBOO_HERMES_STOP_GRACE_MS: '600000' })
    await hermes.stopHermesGatewayForExit({ CLAWBOO_HERMES_STOP_GRACE_MS: '1200' })
    await hermes.stopHermesGatewayForExit({})
    expect(stopForExit.mock.calls).toEqual([[8_000], [1_200], [5_000]])
  })
})
