// OpenClaw's plaintext key store is written owner-only: `.env` and every agent's
// `auth-profiles.json` are 0600, and a state dir Clawboo creates is 0700. The mode
// assertions are POSIX-only: Windows has no group/other bits for chmod to clear.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeOpenclawProviderKey, writeOpenclawProviderKeys } from '../openclawEnv'

const posixOnly = it.skipIf(process.platform === 'win32')
const modeOf = (p: string): number => statSync(p).mode & 0o777

describe('OpenClaw key store file modes', () => {
  let home: string
  let stateDir: string
  let profilePath: string

  /** An agent's auth-profiles.json as OpenClaw leaves it, world-readable. */
  function seedAgentProfile(): void {
    const agentDir = path.join(stateDir, 'agents', 'main', 'agent')
    mkdirSync(agentDir, { recursive: true })
    profilePath = path.join(agentDir, 'auth-profiles.json')
    writeFileSync(profilePath, JSON.stringify({ version: 1, profiles: {}, lastGood: {} }))
    chmodSync(profilePath, 0o644)
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-openclaw-env-'))
    stateDir = path.join(home, '.openclaw')
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('writes the key to .env and the agent profile', () => {
    seedAgentProfile()
    writeOpenclawProviderKeys(stateDir, [{ provider: 'anthropic', key: 'sk-ant-test' }])
    expect(readFileSync(path.join(stateDir, '.env'), 'utf8')).toBe(
      'ANTHROPIC_API_KEY=sk-ant-test\n',
    )
    expect(readFileSync(profilePath, 'utf8')).toContain('sk-ant-test')
  })

  posixOnly('a fresh state dir is 0700 and its .env 0600', () => {
    writeOpenclawProviderKeys(stateDir, [{ provider: 'anthropic', key: 'sk-ant-test' }])
    expect(modeOf(stateDir)).toBe(0o700)
    expect(modeOf(path.join(stateDir, '.env'))).toBe(0o600)
  })

  posixOnly('narrows an existing world-readable .env and auth-profiles.json to 0600', () => {
    seedAgentProfile()
    const envPath = path.join(stateDir, '.env')
    writeFileSync(envPath, 'GATEWAY_AUTH_TOKEN=abc\n')
    chmodSync(envPath, 0o644)
    writeOpenclawProviderKeys(stateDir, [{ provider: 'anthropic', key: 'sk-ant-test' }])
    expect(modeOf(envPath)).toBe(0o600)
    expect(modeOf(profilePath)).toBe(0o600)
  })

  posixOnly("leaves an existing state dir's mode alone (OpenClaw owns it)", () => {
    mkdirSync(stateDir)
    chmodSync(stateDir, 0o755)
    writeOpenclawProviderKeys(stateDir, [{ provider: 'anthropic', key: 'sk-ant-test' }])
    expect(modeOf(stateDir)).toBe(0o755)
  })

  posixOnly('removing a key also narrows both files to 0600', () => {
    seedAgentProfile()
    writeOpenclawProviderKeys(stateDir, [
      { provider: 'anthropic', key: 'sk-ant-test' },
      { provider: 'openai', key: 'sk-oai-test' },
    ])
    const envPath = path.join(stateDir, '.env')
    chmodSync(envPath, 0o644)
    chmodSync(profilePath, 0o644)
    removeOpenclawProviderKey(stateDir, 'anthropic')
    expect(readFileSync(envPath, 'utf8')).toBe('OPENAI_API_KEY=sk-oai-test\n')
    expect(modeOf(envPath)).toBe(0o600)
    expect(modeOf(profilePath)).toBe(0o600)
  })
})
