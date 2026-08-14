// The shared pino instance, exercised against the REAL pino: LOG_LEVEL is
// honored, `createLogger` tags a child, and the redaction surface is
// re-exported. The `formatters.log` wiring is asserted separately in
// loggerConfig.test.ts, which mocks pino to capture its options — pino writes
// through a SonicBoom handle bound to fd 1, so a `process.stdout.write` spy
// never sees the emitted record.
//
// Every load goes through `loadLogger`, which stubs NODE_ENV=production BEFORE
// the import. That is load-bearing, not cosmetic: under vitest NODE_ENV is
// 'test', so a bare import takes the `transport: { target: 'pino-pretty' }`
// branch — which spawns a worker thread, prints colorized noise into the test
// output, and resolves its target by walking the caller's file path (a
// transformed virtual path under vite-node, where the resolve can throw).

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

/** Re-import index.ts under a chosen level, transport-free. */
async function loadLogger(level = 'silent') {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('LOG_LEVEL', level)
  // index.ts reads process.env at module-eval time, so the module cache must go.
  vi.resetModules()
  return import('../index')
}

describe('logger', () => {
  it('honors LOG_LEVEL and builds a transport-free instance', async () => {
    const { logger } = await loadLogger('silent')
    expect(logger.level).toBe('silent')
    expect(logger.isLevelEnabled('info')).toBe(false)
  })

  it('defaults to info when LOG_LEVEL is blank', async () => {
    const { logger } = await loadLogger('   ')
    expect(logger.level).toBe('info')
  })

  it('createLogger tags a child with the module binding', async () => {
    const { createLogger } = await loadLogger('silent')
    expect(createLogger('gateway').bindings()).toEqual({ name: 'clawboo', module: 'gateway' })
  })

  it('re-exports the redaction surface so consumers need one import', async () => {
    const m = await loadLogger()
    expect(m.REDACTION_MASK).toBe('••••')
    expect(typeof m.redactObject).toBe('function')
    expect(typeof m.redactValue).toBe('function')
    expect(typeof m.redactJsonString).toBe('function')
  })
})
