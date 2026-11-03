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

  it('enumerates every name the SDK itself adds underneath', async () => {
    // The transport merges getDefaultEnvironment() UNDER whatever we pass, so a
    // list that omitted those names would document a subset of what the child
    // actually receives.
    const { DEFAULT_INHERITED_ENV_VARS } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    for (const name of DEFAULT_INHERITED_ENV_VARS) {
      expect(CONNECTOR_ENV_ALLOWLIST.has(name), name).toBe(true)
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

  it('passes npm’s prefix, cache and update check through, in either spelling', () => {
    const lower = connectorChildEnv({
      source: {
        ...AMBIENT,
        npm_config_prefix: '/home/dev/.npm-global',
        npm_config_cache: '/home/dev/.cache/npm',
        npm_config_update_notifier: 'false',
      },
    })
    expect(lower['npm_config_prefix']).toBe('/home/dev/.npm-global')
    expect(lower['npm_config_cache']).toBe('/home/dev/.cache/npm')
    expect(lower['npm_config_update_notifier']).toBe('false')

    const upper = connectorChildEnv({
      source: {
        ...AMBIENT,
        NPM_CONFIG_PREFIX: '/opt/npm',
        NPM_CONFIG_CACHE: '/var/cache/npm',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      },
    })
    expect(upper['NPM_CONFIG_PREFIX']).toBe('/opt/npm')
    expect(upper['NPM_CONFIG_CACHE']).toBe('/var/cache/npm')
    expect(upper['NPM_CONFIG_UPDATE_NOTIFIER']).toBe('false')
  })

  it('keeps every other npm setting out, credentials above all', () => {
    const env = connectorChildEnv({
      source: {
        ...AMBIENT,
        npm_config_prefix: '/home/dev/.npm-global',
        npm_config__authToken: 'npm_secret_1',
        NPM_CONFIG__AUTHTOKEN: 'npm_secret_2',
        npm_config__auth: 'dXNlcjpwYXNz',
        NPM_CONFIG__AUTH: 'dXNlcjpwYXNz',
        'npm_config_//registry.npmjs.org/:_authToken': 'npm_secret_3',
        NPM_CONFIG_TOKEN: 'npm_secret_4',
        npm_config_auth_type: 'legacy',
        npm_config_userconfig: '/home/dev/.npmrc',
        npm_config_registry: 'https://registry.example.test/',
      },
    })
    const npmKeys = Object.keys(env).filter((k) => k.toLowerCase().startsWith('npm_config_'))
    // Only the prefix, plus the update check a connector launch turns off.
    expect(npmKeys.sort()).toEqual(['npm_config_prefix', 'npm_config_update_notifier'])
    expect(JSON.stringify(env)).not.toMatch(/npm_secret|dXNlcjpwYXNz/)
  })

  it('allows no name that could carry an npm credential', () => {
    for (const name of CONNECTOR_ENV_ALLOWLIST) {
      if (!name.toLowerCase().startsWith('npm_config_')) continue
      expect(name, name).not.toMatch(/auth|token/i)
    }
  })

  it('turns npm’s update check off for a connector launch', () => {
    // A connector starts through `npx`, which otherwise asks the registry for
    // npm's newest version on its own schedule.
    const env = connectorChildEnv({ source: AMBIENT })
    expect(env['npm_config_update_notifier']).toBe('false')
  })

  it('leaves an update-check setting the operator made alone', () => {
    const env = connectorChildEnv({
      source: { ...AMBIENT, NPM_CONFIG_UPDATE_NOTIFIER: 'true' },
    })
    expect(env['NPM_CONFIG_UPDATE_NOTIFIER']).toBe('true')
    expect('npm_config_update_notifier' in env).toBe(false)
  })

  it('adds no update-check setting when asked to inherit it', () => {
    const env = connectorChildEnv({ source: AMBIENT, npmUpdateCheck: 'inherit' })
    expect(Object.keys(env).some((k) => k.toLowerCase() === 'npm_config_update_notifier')).toBe(
      false,
    )
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
