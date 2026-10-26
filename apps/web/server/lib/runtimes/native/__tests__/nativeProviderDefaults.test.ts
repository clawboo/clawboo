// resolveConnectedNativeDefaults — provider/model/envVar picked from the first
// connected key. Sandboxes $HOME + CLAWBOO_HOME (empty vault / no openclaw .env)
// and isolates the provider env vars so process.env is the only key source.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setKeylessProviderChoice, setRuntimeDisconnected } from '../../../secretsVault'
import {
  canRunNativeProvider,
  isNativeOllamaConnected,
  isNativeOllamaRemoved,
  nativeAgentProviderReady,
  MODEL_DEFAULTS,
  resolveConnectedNativeDefaults,
  resolveDeployNativeDefaults,
} from '../nativeProviderDefaults'
import { __resetOllamaModelsCacheForTests } from '../ollamaModels'

const PROVIDER_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'OLLAMA_BASE_URL',
]

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

  it('a CHOSEN local Ollama resolves with no key and no OLLAMA_BASE_URL', () => {
    // The onboarding / providers-manager pick, and nothing else: agents deployed
    // without an explicit model must land on Ollama, not the Anthropic default.
    setKeylessProviderChoice('ollama', true)
    expect(resolveConnectedNativeDefaults('leader')).toEqual({
      primaryProvider: 'ollama',
      primaryModel: MODEL_DEFAULTS['ollama']!.leader,
      envVar: 'OLLAMA_BASE_URL',
    })
  })

  it('a REMOVED Ollama choice mutes OLLAMA_BASE_URL', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434'
    setKeylessProviderChoice('ollama', false)
    expect(resolveConnectedNativeDefaults('leader').primaryProvider).toBe('anthropic')
  })

  // ── resolveDeployNativeDefaults: the model an agent is CREATED with ──────────
  // The static Ollama default is llama3.2, and an Ollama that never pulled it
  // fails every run. So at create time the default is checked against /api/tags.

  describe('resolveDeployNativeDefaults', () => {
    beforeEach(() => __resetOllamaModelsCacheForTests())
    afterEach(() => vi.unstubAllGlobals())

    function stubTags(names: { name: string; caps?: string[]; modified?: string }[]) {
      const fetchMock = vi.fn(async () =>
        Response.json({
          models: names.map((n) => ({
            name: n.name,
            modified_at: n.modified ?? '2026-09-01T00:00:00Z',
            details: { family: 'llama' },
            capabilities: n.caps ?? ['completion', 'tools'],
          })),
        }),
      )
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('keeps llama3.2 when it is pulled', async () => {
      setKeylessProviderChoice('ollama', true)
      stubTags([
        { name: 'qwen2.5:7b', modified: '2026-10-01T00:00:00Z' },
        { name: 'llama3.2:latest' },
      ])
      expect((await resolveDeployNativeDefaults('leader')).primaryModel).toBe('llama3.2')
    })

    it('swaps an unpulled llama3.2 for a pulled model, the same one for both tiers', async () => {
      setKeylessProviderChoice('ollama', true)
      stubTags([
        { name: 'nomic-embed-text:latest', caps: ['embedding'], modified: '2026-10-09T00:00:00Z' },
        { name: 'qwen2.5:7b' },
      ])
      expect(await resolveDeployNativeDefaults('leader')).toEqual({
        primaryProvider: 'ollama',
        primaryModel: 'qwen2.5:7b',
        envVar: 'OLLAMA_BASE_URL',
      })
      expect((await resolveDeployNativeDefaults('specialist')).primaryModel).toBe('qwen2.5:7b')
    })

    it('keeps llama3.2 when Ollama has nothing to run instead (the UI shows the pull)', async () => {
      setKeylessProviderChoice('ollama', true)
      stubTags([{ name: 'nomic-embed-text:latest', caps: ['embedding'] }])
      expect((await resolveDeployNativeDefaults('leader')).primaryModel).toBe('llama3.2')
    })

    it('reuses one /api/tags answer across the agents of a deploy', async () => {
      setKeylessProviderChoice('ollama', true)
      const fetchMock = stubTags([{ name: 'qwen2.5:7b' }])
      await resolveDeployNativeDefaults('leader')
      await resolveDeployNativeDefaults('specialist')
      await resolveDeployNativeDefaults('specialist')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('never asks Ollama when another provider resolves', async () => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-test'
      setKeylessProviderChoice('ollama', true)
      const fetchMock = stubTags([{ name: 'qwen2.5:7b' }])
      expect(await resolveDeployNativeDefaults('leader')).toEqual(
        resolveConnectedNativeDefaults('leader'),
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

describe('isNativeOllamaConnected', () => {
  let home: string
  const saved: Record<string, string | undefined> = {}
  const VARS = ['HOME', 'CLAWBOO_HOME', 'OLLAMA_BASE_URL'] as const

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ollama-'))
    for (const k of VARS) saved[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    delete process.env['OLLAMA_BASE_URL']
  })
  afterEach(async () => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('is false on a fresh install (no choice, no env var)', () => {
    expect(isNativeOllamaConnected()).toBe(false)
  })

  it('is true once chosen, with no env var', () => {
    setKeylessProviderChoice('ollama', true)
    expect(isNativeOllamaConnected()).toBe(true)
  })

  it('counts OLLAMA_BASE_URL when nothing is recorded', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://box:11434/v1'
    expect(isNativeOllamaConnected()).toBe(true)
  })

  it('a removed choice wins over OLLAMA_BASE_URL', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://box:11434/v1'
    setKeylessProviderChoice('ollama', false)
    expect(isNativeOllamaConnected()).toBe(false)
  })

  it('an explicit runtime disconnect mutes OLLAMA_BASE_URL, like an ambient key', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://box:11434/v1'
    setRuntimeDisconnected('clawboo-native', true)
    expect(isNativeOllamaConnected()).toBe(false)
  })

  it('a forgotten choice falls back to the env var', () => {
    setKeylessProviderChoice('ollama', true)
    setKeylessProviderChoice('ollama', null)
    expect(isNativeOllamaConnected()).toBe(false)
    process.env['OLLAMA_BASE_URL'] = 'http://box:11434/v1'
    expect(isNativeOllamaConnected()).toBe(true)
  })
})

// ── A removed Ollama runs nothing ────────────────────────────────────────────
// "Disconnect Ollama" says Clawboo Native stops using it. Before, agents already
// on an Ollama model kept running and read ready, and a later Boo Zero could land
// on the removed Ollama through the recorded leader pick.

describe('a removed Ollama', () => {
  let home: string
  const saved: Record<string, string | undefined> = {}
  const VARS = ['HOME', 'CLAWBOO_HOME', 'OLLAMA_BASE_URL', 'ANTHROPIC_API_KEY'] as const
  const OLLAMA_AGENT = { primaryProvider: 'ollama', envVar: 'OLLAMA_BASE_URL' }

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-ollama-removed-'))
    for (const k of VARS) saved[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    delete process.env['OLLAMA_BASE_URL']
    delete process.env['ANTHROPIC_API_KEY']
  })
  afterEach(async () => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('can still run while never chosen or chosen; a deliberate pick needs no setup', () => {
    expect(isNativeOllamaRemoved()).toBe(false)
    expect(canRunNativeProvider('ollama')).toBe(true)
    expect(nativeAgentProviderReady(OLLAMA_AGENT)).toBe(true)
    setKeylessProviderChoice('ollama', true)
    expect(canRunNativeProvider('ollama')).toBe(true)
    expect(nativeAgentProviderReady(OLLAMA_AGENT)).toBe(true)
  })

  it('cannot run once removed, and an Ollama agent reads not ready', () => {
    setKeylessProviderChoice('ollama', false)
    expect(isNativeOllamaRemoved()).toBe(true)
    expect(canRunNativeProvider('ollama')).toBe(false)
    expect(nativeAgentProviderReady(OLLAMA_AGENT)).toBe(false)
  })

  it('a keyed fallback still makes the agent ready', () => {
    setKeylessProviderChoice('ollama', false)
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
    expect(
      nativeAgentProviderReady({
        ...OLLAMA_AGENT,
        fallbacks: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
      }),
    ).toBe(true)
  })

  it('only a removal blocks: a choice never made does not', () => {
    setKeylessProviderChoice('ollama', false)
    setKeylessProviderChoice('ollama', null)
    expect(canRunNativeProvider('ollama')).toBe(true)
  })
})
