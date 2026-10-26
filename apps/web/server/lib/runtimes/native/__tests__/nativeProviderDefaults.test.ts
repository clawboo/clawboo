// resolveConnectedNativeDefaults — provider/model/envVar picked from the first
// connected key. Sandboxes $HOME + CLAWBOO_HOME (empty vault / no openclaw .env)
// and isolates the provider env vars so process.env is the only key source.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NATIVE_PROVIDER_ENV_VARS } from '@clawboo/adapter-native'
import { setSetting } from '@clawboo/db'

import { getDb, resetDb } from '../../../db'
import { setKeylessProviderChoice, setRuntimeDisconnected } from '../../../secretsVault'
import {
  canRunNativeProvider,
  isNativeOllamaConnected,
  isNativeOllamaRemoved,
  nativeAgentProviderReady,
  MODEL_DEFAULTS,
  readRecordedNativeDefault,
  resolveConnectedNativeDefaults,
  resolveDeployNativeDefaults,
  resolveNativeTierDefaults,
  SETTING_NATIVE_LEADER_MODEL,
} from '../nativeProviderDefaults'
import { __resetOllamaModelsCacheForTests } from '../ollamaModels'

// Every routable provider's env var, plus the keyless-Ollama signal and the
// OpenClaw state-dir override (an exported one would let the developer's real
// ~/.openclaw/.env satisfy a key lookup that must find nothing here).
const PROVIDER_ENV = [...NATIVE_PROVIDER_ENV_VARS, 'OLLAMA_BASE_URL', 'OPENCLAW_STATE_DIR']

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
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
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
    const r = resolveConnectedNativeDefaults('leader', null)
    expect(r).toEqual({
      primaryProvider: 'anthropic',
      primaryModel: MODEL_DEFAULTS['anthropic']!.leader,
      envVar: 'ANTHROPIC_API_KEY',
    })
  })

  it('OpenAI-only key → openai config, tier-aware model', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai-test'
    expect(resolveConnectedNativeDefaults('leader', null)).toEqual({
      primaryProvider: 'openai',
      primaryModel: MODEL_DEFAULTS['openai']!.leader,
      envVar: 'OPENAI_API_KEY',
    })
    expect(resolveConnectedNativeDefaults('specialist', null).primaryModel).toBe(
      MODEL_DEFAULTS['openai']!.specialist,
    )
  })

  it('anthropic wins over openai (KNOWN_PROVIDERS priority)', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
    process.env['OPENAI_API_KEY'] = 'sk-oai'
    expect(resolveConnectedNativeDefaults('leader', null).primaryProvider).toBe('anthropic')
  })

  it('OLLAMA_BASE_URL is the keyless-ollama signal (placeholder envVar)', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434'
    expect(resolveConnectedNativeDefaults('specialist', null)).toEqual({
      primaryProvider: 'ollama',
      primaryModel: MODEL_DEFAULTS['ollama']!.specialist,
      envVar: 'OLLAMA_BASE_URL',
    })
  })

  it('a CHOSEN local Ollama resolves with no key and no OLLAMA_BASE_URL', () => {
    // The onboarding / providers-manager pick, and nothing else: agents deployed
    // without an explicit model must land on Ollama, not the Anthropic default.
    setKeylessProviderChoice('ollama', true)
    expect(resolveConnectedNativeDefaults('leader', null)).toEqual({
      primaryProvider: 'ollama',
      primaryModel: MODEL_DEFAULTS['ollama']!.leader,
      envVar: 'OLLAMA_BASE_URL',
    })
  })

  it('a REMOVED Ollama choice mutes OLLAMA_BASE_URL', () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434'
    setKeylessProviderChoice('ollama', false)
    expect(resolveConnectedNativeDefaults('leader', null).primaryProvider).toBe('anthropic')
  })

  // ── The user's recorded default ────────────────────────────────────────────
  // Onboarding and "Make default" record { provider, model }. It must win over an
  // ambient key earlier in the fixed order, whenever its provider is set up.

  describe('with a recorded default', () => {
    it('a set-up recorded provider wins over an ambient key earlier in the order', () => {
      // The reported case: the user picked OpenAI, but an ANTHROPIC_API_KEY sits
      // in their shell. The fixed order alone would put every agent on Anthropic.
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-ambient'
      process.env['OPENAI_API_KEY'] = 'sk-oai'
      const recorded = { provider: 'openai', model: 'gpt-4o' }
      expect(resolveConnectedNativeDefaults('leader', recorded)).toEqual({
        primaryProvider: 'openai',
        primaryModel: 'gpt-4o',
        envVar: 'OPENAI_API_KEY',
      })
    })

    it('a specialist gets the recorded provider’s cheaper tier model, not the recorded one', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-ambient'
      process.env['OPENAI_API_KEY'] = 'sk-oai'
      const recorded = { provider: 'openai', model: 'gpt-4o' }
      expect(resolveConnectedNativeDefaults('specialist', recorded)).toEqual({
        primaryProvider: 'openai',
        primaryModel: MODEL_DEFAULTS['openai']!.specialist,
        envVar: 'OPENAI_API_KEY',
      })
    })

    it('a chosen Ollama default beats an ambient key, on its recorded model for both tiers', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-ambient'
      setKeylessProviderChoice('ollama', true)
      const recorded = { provider: 'ollama', model: 'qwen2.5:7b' }
      for (const tier of ['leader', 'specialist'] as const) {
        expect(resolveConnectedNativeDefaults(tier, recorded)).toEqual({
          primaryProvider: 'ollama',
          primaryModel: 'qwen2.5:7b',
          envVar: 'OLLAMA_BASE_URL',
        })
      }
    })

    it('a recorded provider that is not set up falls back to the fixed order', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
      const recorded = { provider: 'openrouter', model: 'minimax/m2.5' }
      expect(resolveConnectedNativeDefaults('leader', recorded)).toEqual({
        primaryProvider: 'anthropic',
        primaryModel: MODEL_DEFAULTS['anthropic']!.leader,
        envVar: 'ANTHROPIC_API_KEY',
      })
    })

    it('a recorded Ollama counts only once Ollama is set up, not merely runnable', () => {
      // Never chosen, no OLLAMA_BASE_URL: the router could still reach it
      // (canRunNativeProvider is true), but it was never set up.
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
      const recorded = { provider: 'ollama', model: 'llama3.2' }
      expect(canRunNativeProvider('ollama')).toBe(true)
      expect(resolveConnectedNativeDefaults('leader', recorded).primaryProvider).toBe('anthropic')
    })

    it('a removed Ollama keeps its recorded default from counting, even with OLLAMA_BASE_URL', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
      process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434'
      setKeylessProviderChoice('ollama', false)
      const recorded = { provider: 'ollama', model: 'qwen2.5:7b' }
      expect(resolveConnectedNativeDefaults('leader', recorded).primaryProvider).toBe('anthropic')
    })
  })

  describe('readRecordedNativeDefault', () => {
    it('parses the stored { provider, model }', () => {
      const db = getDb()
      setSetting(
        db,
        SETTING_NATIVE_LEADER_MODEL,
        JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
      )
      expect(readRecordedNativeDefault(db)).toEqual({ provider: 'openai', model: 'gpt-4o' })
    })

    it('is null when unset or malformed', () => {
      const db = getDb()
      expect(readRecordedNativeDefault(db)).toBeNull()
      for (const raw of [
        '{not json',
        JSON.stringify({ provider: 'openai' }),
        JSON.stringify({ provider: 'openai', model: '' }),
        JSON.stringify({ provider: '', model: 'gpt-4o' }),
        JSON.stringify({ provider: 7, model: 'gpt-4o' }),
      ]) {
        setSetting(db, SETTING_NATIVE_LEADER_MODEL, raw)
        expect(readRecordedNativeDefault(db), raw).toBeNull()
      }
    })
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
      expect((await resolveDeployNativeDefaults('leader', null)).primaryModel).toBe('llama3.2')
    })

    it('swaps an unpulled llama3.2 for a pulled model, the same one for both tiers', async () => {
      setKeylessProviderChoice('ollama', true)
      stubTags([
        { name: 'nomic-embed-text:latest', caps: ['embedding'], modified: '2026-10-09T00:00:00Z' },
        { name: 'qwen2.5:7b' },
      ])
      expect(await resolveDeployNativeDefaults('leader', null)).toEqual({
        primaryProvider: 'ollama',
        primaryModel: 'qwen2.5:7b',
        envVar: 'OLLAMA_BASE_URL',
      })
      expect((await resolveDeployNativeDefaults('specialist', null)).primaryModel).toBe(
        'qwen2.5:7b',
      )
    })

    it('keeps llama3.2 when Ollama has nothing to run instead (the UI shows the pull)', async () => {
      setKeylessProviderChoice('ollama', true)
      stubTags([{ name: 'nomic-embed-text:latest', caps: ['embedding'] }])
      expect((await resolveDeployNativeDefaults('leader', null)).primaryModel).toBe('llama3.2')
    })

    it('reuses one /api/tags answer across the agents of a deploy', async () => {
      setKeylessProviderChoice('ollama', true)
      const fetchMock = stubTags([{ name: 'qwen2.5:7b' }])
      await resolveDeployNativeDefaults('leader', null)
      await resolveDeployNativeDefaults('specialist', null)
      await resolveDeployNativeDefaults('specialist', null)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('keeps a recorded Ollama model that is pulled, on both tiers', async () => {
      setKeylessProviderChoice('ollama', true)
      stubTags([
        { name: 'llama3.2:latest', modified: '2026-10-01T00:00:00Z' },
        { name: 'qwen2.5:7b' },
      ])
      const recorded = { provider: 'ollama', model: 'qwen2.5:7b' }
      expect((await resolveDeployNativeDefaults('leader', recorded)).primaryModel).toBe(
        'qwen2.5:7b',
      )
      expect((await resolveDeployNativeDefaults('specialist', recorded)).primaryModel).toBe(
        'qwen2.5:7b',
      )
    })

    it('swaps a recorded Ollama model that is no longer pulled for one that is', async () => {
      setKeylessProviderChoice('ollama', true)
      stubTags([{ name: 'qwen2.5:7b' }])
      const recorded = { provider: 'ollama', model: 'mistral-nemo' }
      expect(await resolveDeployNativeDefaults('leader', recorded)).toEqual({
        primaryProvider: 'ollama',
        primaryModel: 'qwen2.5:7b',
        envVar: 'OLLAMA_BASE_URL',
      })
    })

    it('a recorded keyed provider never asks Ollama, even with Ollama chosen', async () => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-test'
      setKeylessProviderChoice('ollama', true)
      const fetchMock = stubTags([{ name: 'qwen2.5:7b' }])
      const recorded = { provider: 'openai', model: 'gpt-4o' }
      expect((await resolveDeployNativeDefaults('leader', recorded)).primaryModel).toBe('gpt-4o')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    describe('resolveNativeTierDefaults', () => {
      it('is null when no native provider is set up (nothing would run)', async () => {
        expect(await resolveNativeTierDefaults({ provider: 'openai', model: 'gpt-4o' })).toBeNull()
      })

      it('reports each tier exactly as the deploy path picks it', async () => {
        process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
        expect(
          await resolveNativeTierDefaults({ provider: 'anthropic', model: 'claude-opus-4-8' }),
        ).toEqual({
          leader: { provider: 'anthropic', model: 'claude-opus-4-8' },
          specialist: { provider: 'anthropic', model: MODEL_DEFAULTS['anthropic']!.specialist },
        })
        expect(await resolveNativeTierDefaults(null)).toEqual({
          leader: { provider: 'anthropic', model: MODEL_DEFAULTS['anthropic']!.leader },
          specialist: { provider: 'anthropic', model: MODEL_DEFAULTS['anthropic']!.specialist },
        })
      })

      it('names the pulled model an Ollama agent will really get, not the unpulled pick', async () => {
        setKeylessProviderChoice('ollama', true)
        stubTags([{ name: 'qwen2.5:7b' }])
        expect(
          await resolveNativeTierDefaults({ provider: 'ollama', model: 'mistral-nemo' }),
        ).toEqual({
          leader: { provider: 'ollama', model: 'qwen2.5:7b' },
          specialist: { provider: 'ollama', model: 'qwen2.5:7b' },
        })
      })
    })

    it('never asks Ollama when another provider resolves', async () => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-test'
      setKeylessProviderChoice('ollama', true)
      const fetchMock = stubTags([{ name: 'qwen2.5:7b' }])
      expect(await resolveDeployNativeDefaults('leader', null)).toEqual(
        resolveConnectedNativeDefaults('leader', null),
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
