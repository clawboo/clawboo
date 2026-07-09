// resolveConnectedNativeDefaults — provider/model/envVar picked from the first
// connected key. Sandboxes $HOME + CLAWBOO_HOME (empty vault / no openclaw .env)
// and isolates the provider env vars so process.env is the only key source.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MODEL_DEFAULTS, resolveConnectedNativeDefaults } from '../nativeProviderDefaults'

const PROVIDER_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL']

describe('resolveConnectedNativeDefaults', () => {
  let home: string
  let prevHome: string | undefined
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-defaults-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    for (const k of PROVIDER_ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(async () => {
    for (const k of PROVIDER_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('no key at all → anthropic default (never throws)', () => {
    const r = resolveConnectedNativeDefaults('leader')
    expect(r).toEqual({
      primaryProvider: 'anthropic',
      primaryModel: MODEL_DEFAULTS['anthropic']!.leader,
      envVar: 'ANTHROPIC_API_KEY',
    })
  })

  it('OpenAI-only key → openai config, tier-aware model', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai-test'
    expect(resolveConnectedNativeDefaults('leader')).toEqual({
      primaryProvider: 'openai',
      primaryModel: MODEL_DEFAULTS['openai']!.leader,
      envVar: 'OPENAI_API_KEY',
    })
    expect(resolveConnectedNativeDefaults('specialist').primaryModel).toBe(
      MODEL_DEFAULTS['openai']!.specialist,
    )
  })

  it('anthropic wins over openai (KNOWN_PROVIDERS priority)', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
    process.env['OPENAI_API_KEY'] = 'sk-oai'
    expect(resolveConnectedNativeDefaults('leader').primaryProvider).toBe('anthropic')
  })

  it('OLLAMA_BASE_URL is the keyless-ollama signal (placeholder envVar)', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434'
    expect(resolveConnectedNativeDefaults('specialist')).toEqual({
      primaryProvider: 'ollama',
      primaryModel: MODEL_DEFAULTS['ollama']!.specialist,
      envVar: 'OLLAMA_BASE_URL',
    })
  })
})
