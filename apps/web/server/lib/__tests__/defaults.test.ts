// Production defaults catalog: assert every shipped default has the locked value AND
// is actually read by a consumer (the "every key is read by >=1 file" drift test).
// All DEFAULTS keys are consumed in bootProbe.ts (the config snapshot) — and the
// log level is honored by @clawboo/logger. The package-local operational defaults
// are documented + verified to match their home modules.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DEFAULTS, OPERATIONAL_DEFAULTS, REFERENCED_PACKAGE_DEFAULTS } from '../defaults'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('production defaults catalog', () => {
  it('ships the locked posture values', () => {
    expect(DEFAULTS.logLevel).toBe('info')
    expect(DEFAULTS.budgetPosture).toBe('track-and-warn')
    expect(DEFAULTS.budgetHardCapUsdCents).toBeNull() // no auto-pause until a user sets a cap
    expect(DEFAULTS.budgetWarnSoftPct).toBe(80)
    expect(DEFAULTS.gatewayProbeTimeoutMs).toBe(1500)
    expect(DEFAULTS.otelEnabledByDefault).toBe(false)
  })

  it('every DEFAULTS key is read by >=1 consumer (no orphan defaults)', () => {
    const bootProbe = read('../bootProbe.ts')
    const executorRunner = read('../executorRunner.ts')
    const consumers = `${bootProbe}\n${executorRunner}`
    for (const key of Object.keys(DEFAULTS)) {
      expect(consumers.includes(`DEFAULTS.${key}`), `DEFAULTS.${key} is never read`).toBe(true)
    }
  })

  it('the log level default is honored by @clawboo/logger', () => {
    const logger = read('../../../../../packages/logger/src/index.ts')
    expect(logger).toContain('LOG_LEVEL')
    expect(logger).toContain("'info'")
  })

  it('references the package-local defaults for a single readable catalog', () => {
    expect(REFERENCED_PACKAGE_DEFAULTS.budgetSoftCapPct).toBe(80)
    expect(typeof REFERENCED_PACKAGE_DEFAULTS.circuitBreaker.maxToolIterations).toBe('number')
  })

  it('documents operational defaults that match their home modules', () => {
    expect(OPERATIONAL_DEFAULTS.approvalTtlMs.value).toBe(24 * 60 * 60_000)
    expect(OPERATIONAL_DEFAULTS.approvalTtlMs.env).toBe('CLAWBOO_APPROVAL_TTL_MS')
    expect(OPERATIONAL_DEFAULTS.mcpProbeIntervalMs.value).toBe(60_000)
    expect(OPERATIONAL_DEFAULTS.apiPortStart.value).toBe(18790)
  })
})
