// The boot probe is fired as `void runBootProbe(...)` at the same moment the
// Gateway connect starts, so it used to read whatever state the handshake was in a
// few milliseconds later, which is `connecting`. Measured on a healthy install:
// probe at +60ms, `hello-ok` at +187ms. The check failed on EVERY boot,
// `getLastBootReport()` froze that failure, and `/api/health` then reported
// "running degraded / OpenClaw Gateway not reachable" indefinitely on a Gateway
// that had been connected and serving the whole time.
//
// A warning that is always wrong is worse than no warning. These tests pin both
// halves of the fix: a connection that lands late is reported reachable, and a
// Gateway that never comes up is still reported unreachable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectionState = { value: 'connecting' as string, reads: 0 }

vi.mock('../agentSource', () => ({
  getRegistry: () => ({
    source: {
      health: () => {
        connectionState.reads += 1
        return Promise.resolve({
          ok: connectionState.value === 'connected',
          connection: connectionState.value,
          lastSyncedAt: null,
        })
      },
    },
  }),
}))

vi.mock('@clawboo/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/config')>()
  return {
    ...actual,
    loadSettings: () => ({ gatewayUrl: 'ws://localhost:18789', gatewayToken: 'x' }),
  }
})

import { runBootProbe } from '../bootProbe'

const gatewayCheck = (report: Awaited<ReturnType<typeof runBootProbe>>) =>
  report.checks.find((c) => c.id === 'openclawGatewayReachable')

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-settle-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  connectionState.value = 'connecting'
  connectionState.reads = 0
})

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  delete process.env['CLAWBOO_HOME']
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('boot probe: Gateway connection settling', () => {
  it('reports REACHABLE when the handshake lands after the probe starts', async () => {
    // The real-world case: the probe runs first, `hello-ok` arrives ~130ms later.
    setTimeout(() => {
      connectionState.value = 'connected'
    }, 200).unref()

    const report = await runBootProbe({ port: 18790 })
    expect(gatewayCheck(report)?.ok).toBe(true)
    expect(report.degraded).not.toContain('openclawGatewayReachable')
  })

  it('polls rather than sampling once', async () => {
    // A single read is what made this always-wrong. If someone reverts to one
    // sample, `reads` collapses to 1 and this fails.
    setTimeout(() => {
      connectionState.value = 'connected'
    }, 200).unref()

    await runBootProbe({ port: 18790 })
    expect(connectionState.reads).toBeGreaterThan(1)
  })

  it('still reports UNREACHABLE when the Gateway never connects', async () => {
    // The honest signal has to survive the fix. Waiting must not become
    // "assume it worked".
    const report = await runBootProbe({ port: 18790 })
    expect(gatewayCheck(report)?.ok).toBe(false)
    expect(report.degraded).toContain('openclawGatewayReachable')
    expect(report.fatal).toEqual([]) // degraded, never fatal: SQLite still serves
  })

  it('reports reachable immediately when already connected, without waiting', async () => {
    connectionState.value = 'connected'
    const started = Date.now()
    const report = await runBootProbe({ port: 18790 })
    expect(gatewayCheck(report)?.ok).toBe(true)
    // The settle window is 1500ms; an already-connected Gateway must not pay it.
    expect(Date.now() - started).toBeLessThan(1200)
  })
})
