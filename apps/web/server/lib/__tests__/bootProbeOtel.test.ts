// The OTel line of the boot report. The published `clawboo` package does not
// ship the OpenTelemetry SDK (it is external to the server bundle and not a
// dependency of the CLI), so setting an OTLP endpoint there exports nothing.
// System Health used to read "OTel exporter active" off the endpoint alone.

import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const otelState = vi.hoisted(() => ({
  tracer: null as object | null,
  failure: null as 'sdk-missing' | 'init-failed' | null,
}))

vi.mock('../obs/otel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../obs/otel')>()
  return {
    ...actual,
    initOtel: async () => {},
    getObsTracer: () => otelState.tracer,
    getOtelInitFailure: () => otelState.failure,
  }
})

import { runBootProbe } from '../bootProbe'
import { classifyOtelInitError } from '../obs/otel'

const otelCheck = (report: Awaited<ReturnType<typeof runBootProbe>>) =>
  report.checks.find((c) => c.id === 'otelExporterReachable')

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-bootprobe-otel-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:4318'
  otelState.tracer = null
  otelState.failure = null
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  delete process.env['CLAWBOO_HOME']
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('boot probe: OTel exporter', () => {
  it('an endpoint without the SDK is configured but not active, and the check says why', async () => {
    otelState.failure = 'sdk-missing'

    const report = await runBootProbe({ port: 18790 })

    expect(report.config.otelConfigured).toBe(true)
    expect(report.config.otelActive).toBe(false)
    expect(otelCheck(report)?.ok).toBe(false)
    expect(otelCheck(report)?.message).toContain('does not include the OpenTelemetry SDK')
  })

  it('reports active only when the exporter started', async () => {
    otelState.tracer = {}

    const report = await runBootProbe({ port: 18790 })

    expect(report.config.otelConfigured).toBe(true)
    expect(report.config.otelActive).toBe(true)
    expect(otelCheck(report)?.ok).toBe(true)
  })
})

describe('classifyOtelInitError', () => {
  it('reads a missing SDK package as sdk-missing', () => {
    // The published server bundle is CommonJS, so the lazy import is a require.
    const req = createRequire(import.meta.url)
    let err: unknown
    try {
      req('@opentelemetry/not-a-real-package')
    } catch (e) {
      err = e
    }
    expect(classifyOtelInitError(err)).toBe('sdk-missing')
    expect(
      classifyOtelInitError(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' })),
    ).toBe('sdk-missing')
  })

  it('reads anything else as an init failure', () => {
    expect(classifyOtelInitError(new Error('bad endpoint'))).toBe('init-failed')
    expect(classifyOtelInitError(null)).toBe('init-failed')
  })
})
