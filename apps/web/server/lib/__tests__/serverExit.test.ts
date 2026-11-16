// The server's parts stop on the server's own graceful stop, whenever the signal
// came. Each used to stop itself from a `process.once('SIGTERM')` of its own;
// the OpenClaw registry wired one at module load, so a SIGTERM sent while the
// server was still booting (an app that runs Clawboo can send one) spent it
// before the registry existed, and the real stop never closed the OpenClaw
// connection. Now nothing but the server's stop listens for a signal, it keeps
// one sent during boot, and it calls each part's stop.
//
// Real modules in a sandboxed HOME and CLAWBOO_HOME; fresh copies per test.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SIGNALS = ['SIGTERM', 'SIGINT'] as const
const counts = () => SIGNALS.map((s) => process.listenerCount(s))

let home: string
beforeEach(() => {
  vi.resetModules()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-server-exit-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAWBOO_HOME', path.join(home, '.clawboo'))
  vi.stubEnv('CLAWBOO_AGENT_USER', '')
  vi.stubEnv('CLAWBOO_AGENT_USERS', '')
})
afterEach(async () => {
  const { resetDb } = await import('../db')
  resetDb()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })

describe('the parts of the server and signals', () => {
  it('none of them listens for SIGTERM or SIGINT itself, loaded or started', async () => {
    const before = counts()
    const { getDbPath } = await import('../db')
    expect(getDbPath().startsWith(home)).toBe(true)

    // Loading the registry module wired a one-shot SIGTERM listener before.
    const registry = await import('../agentSource/registry')
    expect(counts()).toEqual(before)
    registry.getRegistry()

    const reaper = await import('../approvalReaper')
    reaper.startApprovalReaper({ log: log() })
    const mcp = await import('../mcpSupervisor')
    mcp.startMcpSupervisor({ log: log() })
    const ticker = await import('../routines/ticker')
    ticker.startRoutinesTicker({ log: log(), mcpBaseUrl: null })
    expect(ticker.getRoutinesTicker()).not.toBeNull()
    expect(counts()).toEqual(before)

    const { stopServerParts } = await import('../serverExit')
    await stopServerParts(log())
    expect(ticker.getRoutinesTicker()).toBeNull()
    await registry.stopRegistry()
  })

  it('the trace exporter, once started, listens for no signal either, and a hung flush is cut short', async () => {
    // A stand-in SDK whose flush never settles: an unreachable collector.
    const shutdown = vi.fn(() => new Promise<void>(() => {}))
    vi.doMock('@opentelemetry/sdk-node', () => ({
      NodeSDK: class {
        start(): void {}
        shutdown = shutdown
      },
      api: {
        trace: {
          getTracer: () => ({ startActiveSpan: () => undefined }),
          setSpanContext: () => ({}),
        },
        context: { active: () => ({}) },
        SpanStatusCode: { ERROR: 2 },
        TraceFlags: { SAMPLED: 1 },
      },
    }))
    vi.doMock('@opentelemetry/exporter-trace-otlp-http', () => ({
      OTLPTraceExporter: class {},
    }))
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:9')
    const before = counts()
    const otel = await import('../obs/otel')
    await otel.initOtel()
    expect(otel.getOtelInitFailure()).toBeNull()
    expect(otel.getObsTracer()).not.toBeNull()
    expect(counts()).toEqual(before)
    const t0 = Date.now()
    await otel.shutdownOtel(300)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(Date.now() - t0).toBeLessThan(1_500)
    // A second stop has nothing left to flush.
    await otel.shutdownOtel(300)
    expect(shutdown).toHaveBeenCalledTimes(1)
    vi.doUnmock('@opentelemetry/sdk-node')
    vi.doUnmock('@opentelemetry/exporter-trace-otlp-http')
  })
})

describe('the graceful stop', () => {
  /** A stand-in process: signals are emitted on it, never on the test worker. */
  function fakeProcess() {
    return new EventEmitter() as EventEmitter & { send?: unknown }
  }

  it('closes the OpenClaw connection though the SIGTERM came while the server booted', async () => {
    const { installServerStop, watchEmbedderChannel, watchStopSignals } =
      await import('../serverStop')
    const proc = fakeProcess()
    const signals = watchStopSignals(proc)
    const channel = watchEmbedderChannel(proc, {})

    // Boot: the SIGTERM arrives before the registry exists.
    proc.emit('SIGTERM')
    const registry = await import('../agentSource/registry')
    const reg = registry.getRegistry()
    const regStop = vi.spyOn(reg, 'stop')
    const ticker = await import('../routines/ticker')
    ticker.startRoutinesTicker({ log: log(), mcpBaseUrl: null })

    const { stopServerParts } = await import('../serverExit')
    const exit = vi.fn<(code: number) => void>()
    const l = log()
    installServerStop({
      proc,
      signals,
      channel,
      gracefulExit: () => stopServerParts(l, { env: {} }),
      exit,
      onStopping: (why) => l.info({ why }, 'Stopping the server'),
    })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(l.info).toHaveBeenCalledWith({ why: 'SIGTERM' }, 'Stopping the server')
    // No run may start while the stop waits: the engine holds itself.
    const { engineHold } = await import('../engineHold')
    expect(
      engineHold()
        .list()
        .map((h) => h.owner),
    ).toEqual(['server-stop'])
    expect(regStop).toHaveBeenCalledTimes(1)
    expect((await reg.source.health()).connection).toBe('disconnected')
    expect(ticker.getRoutinesTicker()).toBeNull()
  })

  it('waits for nothing when no part was ever started', async () => {
    const { stopServerParts } = await import('../serverExit')
    const t0 = performance.now()
    const l = log()
    await stopServerParts(l)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(l.warn).not.toHaveBeenCalled()
  })
})
