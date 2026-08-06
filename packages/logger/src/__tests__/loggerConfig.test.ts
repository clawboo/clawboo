// The OPTIONS index.ts hands to pino. This is where the security-relevant
// wiring lives: `formatters.log` must be the redactObject hook, or every log
// record ships credentials in the clear. redact.test.ts proves the function
// works; this file proves something actually calls it.
//
// pino is mocked (hoisted) rather than spied on because pino's default
// destination is a SonicBoom handle bound to fd 1 — it bypasses
// `process.stdout.write` entirely, so an output spy captures nothing. Capturing
// the constructor argument is both deterministic and lets us assert the dev vs.
// production transport branch, which an output spy could never reach.
//
// Kept in its own file: `vi.mock` is hoisted to the top of the module, so the
// real-pino assertions in logger.test.ts cannot share a file with it.

import { afterEach, describe, expect, it, vi } from 'vitest'

interface PinoOptions {
  name?: string
  level?: string
  formatters?: { log?: (obj: Record<string, unknown>) => Record<string, unknown> }
  transport?: { target?: string; options?: Record<string, unknown> }
}

const captured: PinoOptions[] = []

vi.mock('pino', () => {
  const fake = { child: () => fake }
  return {
    default: (opts: PinoOptions) => {
      captured.push(opts)
      return fake
    },
  }
})

afterEach(() => {
  captured.length = 0
  vi.unstubAllEnvs()
  vi.resetModules()
})

/** Re-import index.ts and return the options it passed to pino(). */
async function loadOptions(env: Record<string, string>): Promise<PinoOptions> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules() // index.ts reads process.env at module-eval time
  await import('../index')
  expect(captured).toHaveLength(1)
  return captured[0] as PinoOptions
}

describe('pino options', () => {
  it('names the logger and takes its level from LOG_LEVEL', async () => {
    const opts = await loadOptions({ NODE_ENV: 'production', LOG_LEVEL: 'debug' })
    expect(opts.name).toBe('clawboo')
    expect(opts.level).toBe('debug')
  })

  it('defaults to info — debug is too noisy for a shipped product', async () => {
    expect((await loadOptions({ NODE_ENV: 'production', LOG_LEVEL: '' })).level).toBe('info')
  })

  it('ships NO transport in production (pino-pretty is a dev-only worker)', async () => {
    expect((await loadOptions({ NODE_ENV: 'production' })).transport).toBeUndefined()
  })

  it('attaches the pino-pretty transport outside production', async () => {
    const opts = await loadOptions({ NODE_ENV: 'development' })
    expect(opts.transport?.target).toBe('pino-pretty')
    expect(opts.transport?.options).toEqual({ colorize: true })
  })

  it('wires formatters.log to the redaction hook', async () => {
    const { formatters } = await loadOptions({ NODE_ENV: 'production' })
    expect(typeof formatters?.log).toBe('function')

    // The hook runs on EVERY record, so both halves of the contract matter:
    // credential keys mask, numeric token telemetry survives.
    expect(formatters?.log?.({ apiKey: 'sk-abcdefghijklmnop', inputTokens: 42 })).toEqual({
      apiKey: '••••',
      inputTokens: 42,
    })
  })

  it('the formatters.log hook redacts nested and value-shaped credentials too', async () => {
    const { formatters } = await loadOptions({ NODE_ENV: 'production' })
    expect(
      formatters?.log?.({ ctx: { note: 'key sk-abcdefghijklmnop here', cost: 1.25 } }),
    ).toEqual({ ctx: { note: 'key •••• here', cost: 1.25 } })
  })
})
