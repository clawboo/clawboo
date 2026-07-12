// buildChildEnv is what every spawned runtime's env flows through. It must strip clawboo's
// OWN server secrets AND the operator's curated third-party shell secrets (so an untrusted
// agent subprocess can't `env`-dump them) while preserving PATH/HOME/infra + the ambient
// provider-auth the CLIs read + merging the caller's granted provider keys on top.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildChildEnv } from '../childEnv'

const SAVED = [
  'GATEWAY_AUTH_TOKEN',
  'STUDIO_ACCESS_TOKEN',
  'CLAWBOO_SECRETS_MASTER_KEY',
  'BETTER_AUTH_SECRET',
  // operator third-party secrets
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_REGION',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'DATABASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  // ambient provider-auth the CLIs legitimately read (must survive)
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const

describe('buildChildEnv', () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    process.env['GATEWAY_AUTH_TOKEN'] = 'gw-secret'
    process.env['STUDIO_ACCESS_TOKEN'] = 'studio-secret'
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = 'master-secret'
    process.env['BETTER_AUTH_SECRET'] = 'better-secret'
    // Clear the Bedrock flag by default so AWS creds are scrubbed unless a test opts in.
    delete process.env['CLAUDE_CODE_USE_BEDROCK']
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

  it('strips the operator third-party shell secrets (env-dump defense)', () => {
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-secret'
    process.env['AWS_ACCESS_KEY_ID'] = 'aws-id'
    process.env['GITHUB_TOKEN'] = 'gh-secret'
    process.env['NPM_TOKEN'] = 'npm-secret'
    process.env['DATABASE_URL'] = 'postgres://user:pw@host/db'
    const env = buildChildEnv()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(env['AWS_ACCESS_KEY_ID']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['NPM_TOKEN']).toBeUndefined()
    expect(env['DATABASE_URL']).toBeUndefined()
  })

  it('preserves ambient provider-auth the CLIs read + infra config (never a name heuristic)', () => {
    // These would be caught by a broad /API_KEY|TOKEN/ regex, but the CLIs authenticate
    // with them from the ambient env, so they MUST survive.
    process.env['OPENAI_API_KEY'] = 'codex-key' // Codex reads this from ambient env
    process.env['GEMINI_API_KEY'] = 'hermes-key' // Hermes' configured provider key
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'cc-token' // Claude Code alt auth
    process.env['AWS_REGION'] = 'us-east-1' // config, not a secret
    const env = buildChildEnv()
    expect(env['OPENAI_API_KEY']).toBe('codex-key')
    expect(env['GEMINI_API_KEY']).toBe('hermes-key')
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('cc-token')
    expect(env['AWS_REGION']).toBe('us-east-1')
  })

  it('keeps AWS creds ONLY when Claude Code Bedrock mode is explicitly enabled', () => {
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-secret'
    process.env['AWS_ACCESS_KEY_ID'] = 'aws-id'
    process.env['CLAUDE_CODE_USE_BEDROCK'] = '1'
    const env = buildChildEnv()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBe('aws-secret')
    expect(env['AWS_ACCESS_KEY_ID']).toBe('aws-id')
  })

  it('merges the granted provider key on top, even when scrubbing ran', () => {
    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'granted-key' })
    expect(env['ANTHROPIC_API_KEY']).toBe('granted-key')
    // Secrets still absent.
    expect(env['GATEWAY_AUTH_TOKEN']).toBeUndefined()
    expect(env['STUDIO_ACCESS_TOKEN']).toBeUndefined()
  })

  it('a granted key is restored even if its name is in a scrub list', () => {
    process.env['GITHUB_TOKEN'] = 'ambient-gh'
    // A caller that explicitly grants a scrubbed-name key gets it back (grant wins).
    const env = buildChildEnv({ GITHUB_TOKEN: 'granted-gh' })
    expect(env['GITHUB_TOKEN']).toBe('granted-gh')
  })

  it('the serialized env never contains the secret VALUES', () => {
    process.env['GITHUB_TOKEN'] = 'gh-operator-secret'
    const blob = JSON.stringify(buildChildEnv({ OPENROUTER_API_KEY: 'or-key' }))
    expect(blob).not.toContain('gw-secret')
    expect(blob).not.toContain('studio-secret')
    expect(blob).not.toContain('master-secret')
    expect(blob).not.toContain('gh-operator-secret')
    expect(blob).toContain('or-key')
  })
})
