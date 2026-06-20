// buildChildEnv is what every spawned runtime's env flows through. It must strip
// clawboo's OWN server secrets (so an untrusted agent subprocess can't read them) while
// preserving PATH/HOME/etc and merging the caller's granted provider keys.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildChildEnv } from '../childEnv'

const SAVED = [
  'GATEWAY_AUTH_TOKEN',
  'STUDIO_ACCESS_TOKEN',
  'CLAWBOO_SECRETS_MASTER_KEY',
  'BETTER_AUTH_SECRET',
] as const

describe('buildChildEnv', () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    process.env['GATEWAY_AUTH_TOKEN'] = 'gw-secret'
    process.env['STUDIO_ACCESS_TOKEN'] = 'studio-secret'
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = 'master-secret'
    process.env['BETTER_AUTH_SECRET'] = 'better-secret'
  })
  afterEach(() => {
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })

  it('strips clawboo server secrets but keeps benign env (PATH)', () => {
    const env = buildChildEnv()
    expect(env['GATEWAY_AUTH_TOKEN']).toBeUndefined()
    expect(env['STUDIO_ACCESS_TOKEN']).toBeUndefined()
    expect(env['CLAWBOO_SECRETS_MASTER_KEY']).toBeUndefined()
    expect(env['BETTER_AUTH_SECRET']).toBeUndefined()
    expect(env['PATH']).toBe(process.env['PATH'])
  })

  it('merges the granted provider key on top, even when scrubbing ran', () => {
    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'granted-key' })
    expect(env['ANTHROPIC_API_KEY']).toBe('granted-key')
    // Secrets still absent.
    expect(env['GATEWAY_AUTH_TOKEN']).toBeUndefined()
    expect(env['STUDIO_ACCESS_TOKEN']).toBeUndefined()
  })

  it('the serialized env never contains the secret VALUES', () => {
    const blob = JSON.stringify(buildChildEnv({ OPENROUTER_API_KEY: 'or-key' }))
    expect(blob).not.toContain('gw-secret')
    expect(blob).not.toContain('studio-secret')
    expect(blob).not.toContain('master-secret')
    expect(blob).toContain('or-key')
  })
})
