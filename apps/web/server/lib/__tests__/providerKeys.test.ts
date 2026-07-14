// The unified provider-key store — a key set once lands in BOTH stores (encrypted
// vault + OpenClaw .env), disconnect clears both, and status reflects either store.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getRuntimeSecret } from '../secretsVault'
import { openclawEnvHasKey, writeOpenclawProviderKeys } from '../openclawEnv'
import {
  connectProviderKey,
  disconnectProviderKey,
  isKnownProvider,
  providerStatus,
} from '../providerKeys'

describe('providerKeys', () => {
  let clawbooHome: string
  let stateDir: string
  const prev: Record<string, string | undefined> = {}
  // Clear ambient provider vars — a real exported key would shadow the vault +
  // .env under test (process.env wins in resolveRuntimeKey by design).
  const SAVED = [
    'CLAWBOO_HOME',
    'CLAWBOO_SECRETS_MASTER_KEY',
    'OPENCLAW_STATE_DIR',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'MISTRAL_API_KEY',
  ] as const

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    clawbooHome = mkdtempSync(path.join(os.tmpdir(), 'clawboo-prov-home-'))
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-prov-state-'))
    process.env['CLAWBOO_HOME'] = clawbooHome
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
    for (const k of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY'])
      delete process.env[k]
  })
  afterEach(() => {
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(clawbooHome, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('connect writes the key to BOTH the vault and OpenClaw .env', () => {
    connectProviderKey('anthropic', 'sk-ant-xyz')
    expect(getRuntimeSecret('ANTHROPIC_API_KEY')).toBe('sk-ant-xyz')
    const env = readFileSync(path.join(stateDir, '.env'), 'utf8')
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-xyz')
    expect(openclawEnvHasKey(stateDir, 'ANTHROPIC_API_KEY')).toBe(true)
  })

  it('maps google → GEMINI_API_KEY in both stores', () => {
    connectProviderKey('google', 'AIza-key')
    expect(getRuntimeSecret('GEMINI_API_KEY')).toBe('AIza-key')
    expect(openclawEnvHasKey(stateDir, 'GEMINI_API_KEY')).toBe(true)
  })

  it('disconnect clears the key from BOTH stores', () => {
    connectProviderKey('openrouter', 'sk-or-abc')
    expect(getRuntimeSecret('OPENROUTER_API_KEY')).toBe('sk-or-abc')
    disconnectProviderKey('openrouter')
    expect(getRuntimeSecret('OPENROUTER_API_KEY')).toBeNull()
    expect(openclawEnvHasKey(stateDir, 'OPENROUTER_API_KEY')).toBe(false)
  })

  it('providerStatus reflects a connected provider + its poweredRuntimes', () => {
    connectProviderKey('anthropic', 'sk-ant-1')
    const st = providerStatus()
    const anthropic = st.find((p) => p.id === 'anthropic')
    expect(anthropic?.connected).toBe(true)
    expect(anthropic?.poweredRuntimes).toEqual(['Clawboo Native', 'Claude Code', 'OpenClaw'])
    expect(st.find((p) => p.id === 'xai')?.connected).toBe(false)
  })

  it('status is connected when only the OpenClaw .env has the key (vault empty)', () => {
    writeOpenclawProviderKeys(stateDir, [{ provider: 'mistral', key: 'm-key' }])
    expect(getRuntimeSecret('MISTRAL_API_KEY')).toBeNull() // never entered the vault
    expect(providerStatus().find((p) => p.id === 'mistral')?.connected).toBe(true)
  })

  it('isKnownProvider gates the id set', () => {
    expect(isKnownProvider('anthropic')).toBe(true)
    expect(isKnownProvider('huggingface')).toBe(true)
    expect(isKnownProvider('nope')).toBe(false)
  })
})
