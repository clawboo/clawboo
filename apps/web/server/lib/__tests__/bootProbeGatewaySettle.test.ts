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
// Gateway that never comes up is still reported unreachable. A Gateway nothing
// uses yet (the server connects on demand) is reported not in use, at once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectionState = {
  value: 'connecting' as string,
  reads: 0,
  /** When set, the connection lands at this read, whenever the probe gets to it. */
  connectAtRead: 0,
  /** What the source says while nothing has needed the Gateway (undefined: in use). */
  inUse: undefined as boolean | undefined,
}

vi.mock('../agentSource', () => ({
  getRegistry: () => ({
    source: {
      health: () => {
        connectionState.reads += 1
        if (
          connectionState.connectAtRead &&
          connectionState.reads >= connectionState.connectAtRead
        ) {
          connectionState.value = 'connected'
        }
        return Promise.resolve({
          ok: connectionState.value === 'connected',
          connection: connectionState.value,
          lastSyncedAt: null,
          ...(connectionState.inUse !== undefined ? { inUse: connectionState.inUse } : {}),
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
    isGatewayConfigured: () => true,
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
  connectionState.connectAtRead = 0
  connectionState.inUse = undefined
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
    // sample, `reads` collapses to 1 and this fails. The connection lands at the
    // second read, not after a fixed time: the checks before this one take long
    // enough on a slow runner that a timer could fire before the first read.
    connectionState.connectAtRead = 2

    const report = await runBootProbe({ port: 18790 })
    expect(connectionState.reads).toBeGreaterThan(1)
    expect(gatewayCheck(report)?.ok).toBe(true)
  })

  it('still reports UNREACHABLE when the Gateway never connects', async () => {
    // The honest signal has to survive the fix. Waiting must not become
    // "assume it worked".
    const report = await runBootProbe({ port: 18790 })
    expect(gatewayCheck(report)?.ok).toBe(false)
    expect(report.degraded).toContain('openclawGatewayReachable')
    expect(report.fatal).toEqual([]) // degraded, never fatal: SQLite still serves
  })

  it('reports NOT IN USE, passing and without waiting, while nothing needs the Gateway', async () => {
    // An install with OpenClaw set up and no OpenClaw agent: the server has not
    // connected on purpose, so a Gateway that starts on its first connection stays
    // asleep. "Not reachable" would be a false alarm, and waiting the whole settle
    // window for a connect nobody started would only slow the boot report.
    connectionState.value = 'disconnected'
    connectionState.inUse = false
    const report = await runBootProbe({ port: 18790 })
    const check = gatewayCheck(report)
    expect(check?.ok).toBe(true)
    expect(check?.message).toMatch(/not in use/)
    expect(report.degraded).not.toContain('openclawGatewayReachable')
    expect(check?.durationMs).toBeLessThan(1200)
  })

  it('a Gateway in use that never connects is still UNREACHABLE', async () => {
    connectionState.value = 'disconnected'
    connectionState.inUse = true
    const report = await runBootProbe({ port: 18790 })
    expect(gatewayCheck(report)?.ok).toBe(false)
    expect(gatewayCheck(report)?.message).toMatch(/not reachable/)
  })

  it('reports reachable immediately when already connected, without waiting', async () => {
    connectionState.value = 'connected'
    const report = await runBootProbe({ port: 18790 })
    const check = gatewayCheck(report)
    expect(check?.ok).toBe(true)
    // The settle window is 1500ms; an already-connected Gateway must not pay it.
    // Time the Gateway check alone, not the whole probe: the checks before it
    // build a fresh database and four MCP servers, and on a loaded Windows CI
    // runner those alone ran past 1200ms while this check took a few ms.
    expect(check?.durationMs).toBeLessThan(1200)
  })
})
