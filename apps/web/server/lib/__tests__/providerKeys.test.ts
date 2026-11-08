// The unified provider-key store — a key set once lands in BOTH stores (encrypted
// vault + OpenClaw .env), disconnect clears both, and status reflects either store.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getRuntimeSecret } from '../secretsVault'
import { ENV_KEY_MAP, openclawEnvHasKey, writeOpenclawProviderKeys } from '../openclawEnv'
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
  const PROVIDER_VARS = [...new Set(Object.values(ENV_KEY_MAP))]
  const SAVED = [
    'CLAWBOO_HOME',
    'CLAWBOO_SECRETS_MASTER_KEY',
    'OPENCLAW_STATE_DIR',
    ...PROVIDER_VARS,
  ]

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    clawbooHome = mkdtempSync(path.join(os.tmpdir(), 'clawboo-prov-home-'))
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-prov-state-'))
    process.env['CLAWBOO_HOME'] = clawbooHome
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
    for (const k of PROVIDER_VARS) delete process.env[k]
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
    expect(anthropic?.poweredRuntimes).toEqual([
      'Claude Code',
      'Hermes',
      'Clawboo Native',
      'OpenClaw',
    ])
    expect(st.find((p) => p.id === 'xai')?.connected).toBe(false)
  })

  it('poweredRuntimes follows the env vars each runtime reads', () => {
    const powered = (id: string) => providerStatus().find((p) => p.id === id)?.poweredRuntimes
    // Clawboo Native drives Google, xAI and the rest directly, not only the big three.
    expect(powered('google')).toEqual(['Clawboo Native', 'OpenClaw'])
    expect(powered('xai')).toEqual(['Clawboo Native', 'OpenClaw'])
    // Hermes reads OpenAI and Anthropic keys as well as OpenRouter.
    expect(powered('openai')).toEqual(['Hermes', 'Clawboo Native', 'OpenClaw'])
    expect(powered('openrouter')).toEqual(['Hermes', 'Clawboo Native', 'OpenClaw'])
    // A provider only OpenClaw reads.
    expect(powered('minimax')).toEqual(['OpenClaw'])
  })

  it('status is connected when only the OpenClaw .env has the key (vault empty)', () => {
    writeOpenclawProviderKeys(stateDir, [{ provider: 'mistral', key: 'm-key' }])
    expect(getRuntimeSecret('MISTRAL_API_KEY')).toBeNull() // never entered the vault
    expect(providerStatus().find((p) => p.id === 'mistral')?.connected).toBe(true)
  })

  it('counts a key set only in the environment as connected, but not saved', () => {
    const groq = providerStatus({ GROQ_API_KEY: 'gsk-env' }).find((p) => p.id === 'groq')
    expect(groq).toMatchObject({
      connected: true,
      saved: false,
      fromEnvironment: true,
      envVar: 'GROQ_API_KEY',
    })
    expect(providerStatus({ GROQ_API_KEY: '  ' }).find((p) => p.id === 'groq')).toMatchObject({
      connected: false,
      fromEnvironment: false,
    })
  })

  it('says a saved key and the same variable in the environment are both there', () => {
    connectProviderKey('anthropic', 'sk-ant-saved')
    const anthropic = providerStatus({ ANTHROPIC_API_KEY: 'sk-ant-env' }).find(
      (p) => p.id === 'anthropic',
    )
    expect(anthropic).toMatchObject({ connected: true, saved: true, fromEnvironment: true })
    // Disconnect removes the saved copy only: the environment still supplies one.
    disconnectProviderKey('anthropic')
    expect(
      providerStatus({ ANTHROPIC_API_KEY: 'sk-ant-env' }).find((p) => p.id === 'anthropic'),
    ).toMatchObject({ connected: true, saved: false })
  })

  it('isKnownProvider gates the id set', () => {
    expect(isKnownProvider('anthropic')).toBe(true)
    expect(isKnownProvider('huggingface')).toBe(true)
    expect(isKnownProvider('nope')).toBe(false)
  })
})
