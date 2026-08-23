import { describe, expect, it } from 'vitest'

import { CONNECTOR_ENV_ALLOWLIST, connectorChildEnv } from '../env'

/** An ambient environment holding the things an operator really does export. */
const AMBIENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/Users/dev',
  LANG: 'en_US.UTF-8',
  // Provider auth the runtime denylist deliberately preserves.
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  OPENROUTER_API_KEY: 'sk-or-secret',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  // clawboo's own secrets.
  CLAWBOO_SECRETS_MASTER_KEY: 'master',
  STUDIO_ACCESS_TOKEN: 'gate',
  GATEWAY_AUTH_TOKEN: 'gw',
  // Operator third-party credentials.
  GITHUB_TOKEN: 'ghp_x',
  AWS_SECRET_ACCESS_KEY: 'aws',
  KUBECONFIG: '/Users/dev/.kube/config',
  DATABASE_URL: 'postgres://u:p@h/db',
  NPM_TOKEN: 'npm',
}

describe('connectorChildEnv', () => {
  it('passes NO provider key, clawboo secret, or operator credential', () => {
    const env = connectorChildEnv({ source: AMBIENT })
    for (const leaked of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAWBOO_SECRETS_MASTER_KEY',
      'STUDIO_ACCESS_TOKEN',
      'GATEWAY_AUTH_TOKEN',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'KUBECONFIG',
      'DATABASE_URL',
      'NPM_TOKEN',
    ]) {
      expect(env[leaked], leaked).toBeUndefined()
    }
  })

  it('is an ALLOWLIST: every key it emits is one we enumerated', () => {
    // The property that makes this different from the runtime denylist. A
    // variable nobody thought of cannot arrive here by default; it can only
    // arrive by being declared.
    const env = connectorChildEnv({ source: AMBIENT })
    for (const key of Object.keys(env)) {
      expect(CONNECTOR_ENV_ALLOWLIST.has(key), key).toBe(true)
    }
  })

  it('keeps what a process needs to start', () => {
    const env = connectorChildEnv({ source: AMBIENT })
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/Users/dev')
    expect(env['LANG']).toBe('en_US.UTF-8')
  })

  it('merges DECLARED credentials, and only those', () => {
    const env = connectorChildEnv({
      source: AMBIENT,
      declared: { NOTION_TOKEN: 'ntn_declared' },
    })
    expect(env['NOTION_TOKEN']).toBe('ntn_declared')
    // Declaring one key does not open the door for the rest.
    expect(env['GITHUB_TOKEN']).toBeUndefined()
  })

  it('drops an empty declared value rather than passing an empty string', () => {
    // A connector that reads "" as "configured" fails far more confusingly than
    // one that reports the variable as missing.
    const env = connectorChildEnv({ source: AMBIENT, declared: { NOTION_TOKEN: '' } })
    expect('NOTION_TOKEN' in env).toBe(false)
  })

  it('carries the Windows variables a child cannot start without', () => {
    // Omit SystemRoot and process creation itself fails, because the loader
    // resolves system DLLs relative to it.
    const env = connectorChildEnv({
      source: {
        SystemRoot: 'C:\\Windows',
        APPDATA: 'C:\\Users\\d\\AppData\\Roaming',
        PATH: 'C:\\',
      },
    })
    expect(env['SystemRoot']).toBe('C:\\Windows')
    expect(env['APPDATA']).toBe('C:\\Users\\d\\AppData\\Roaming')
  })
})
