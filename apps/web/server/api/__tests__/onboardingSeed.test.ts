// Onboarding native leader-model REST. Sandboxes CLAWBOO_HOME (fresh DB per test)
// and drives the POST / GET pair: the pick is recorded, validated, read back, and
// retro-applied to an existing native Boo Zero.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_CONFIG, NATIVE_PROVIDER_ENV_VARS } from '@clawboo/adapter-native'
import { getSetting, setSetting } from '@clawboo/db'

import { onboardingNativeLeaderModelGET, onboardingNativeLeaderModelPOST } from '../onboardingSeed'
import { getDb, resetDb } from '../../lib/db'
import { loadAgentConfig, saveAgentConfig } from '../../lib/runtimes/native/agentConfigStore'
import { __resetOllamaModelsCacheForTests } from '../../lib/runtimes/native/ollamaModels'
import { setKeylessProviderChoice } from '../../lib/secretsVault'
import { SETTING_NATIVE_BOO_ZERO_ID, SETTING_NATIVE_LEADER_MODEL } from '../../lib/teamChat/booZero'

interface Mock {
  res: Response
  statusCode: () => number
  body: () => unknown
}
function mockRes(): Mock {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload }
}
const req = (body: Record<string, unknown> = {}): Request =>
  ({ params: {}, query: {}, body }) as unknown as Request

describe('onboarding native-leader-model REST', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  // The provider env vars too: GET reports what auto-resolve would pick, and a
  // key exported in the developer's shell must not leak into it.
  const SAVED = [
    'CLAWBOO_HOME',
    'OPENCLAW_STATE_DIR',
    'OLLAMA_BASE_URL',
    ...NATIVE_PROVIDER_ENV_VARS,
  ] as const

  beforeEach(() => {
    for (const k of SAVED) {
      prev[k] = process.env[k]
      delete process.env[k]
    }
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-lm-'))
    process.env['CLAWBOO_HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = mkdtempSync(path.join(os.tmpdir(), 'clawboo-lm-state-'))
  })
  afterEach(() => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('records the chosen provider + model to the leader-model setting', () => {
    const m = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'anthropic', model: 'claude-sonnet-5' }), m.res)
    expect(m.statusCode()).toBe(200)
    const db = getDb()
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })

  it('rejects an unknown provider (400) and a missing model (400)', () => {
    const bad = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'nope', model: 'x' }), bad.res)
    expect(bad.statusCode()).toBe(400)

    const noModel = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'anthropic' }), noModel.res)
    expect(noModel.statusCode()).toBe(400)
  })

  it('GET returns the stored default (and null/null when never set)', async () => {
    const empty = mockRes()
    await onboardingNativeLeaderModelGET(req({}), empty.res)
    expect(empty.body()).toEqual({ provider: null, model: null, resolved: null })

    onboardingNativeLeaderModelPOST(
      req({ provider: 'openrouter', model: 'minimax/m2.5' }),
      mockRes().res,
    )
    const m = mockRes()
    await onboardingNativeLeaderModelGET(req({}), m.res)
    // No provider is set up, so nothing would run: `resolved` stays null.
    expect(m.body()).toEqual({ provider: 'openrouter', model: 'minimax/m2.5', resolved: null })
  })

  it('GET resolves what an agent without a model pick gets, per tier', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-ambient'
    process.env['OPENAI_API_KEY'] = 'sk-oai'
    const none = mockRes()
    await onboardingNativeLeaderModelGET(req({}), none.res)
    // No recorded default: the fixed order (Anthropic first) on its tier models.
    expect((none.body() as { resolved: unknown }).resolved).toEqual({
      leader: { provider: 'anthropic', model: 'claude-sonnet-5' },
      specialist: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    })

    onboardingNativeLeaderModelPOST(req({ provider: 'openai', model: 'gpt-4o' }), mockRes().res)
    const m = mockRes()
    await onboardingNativeLeaderModelGET(req({}), m.res)
    expect(m.body()).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      resolved: {
        leader: { provider: 'openai', model: 'gpt-4o' },
        specialist: { provider: 'openai', model: 'gpt-4o-mini' },
      },
    })
  })

  it('GET still resolves from the fixed order when the stored setting is corrupt', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
    setSetting(getDb(), SETTING_NATIVE_LEADER_MODEL, '{not json')
    const m = mockRes()
    await onboardingNativeLeaderModelGET(req({}), m.res)
    // A plain "Default" would hide which model each row gets; the fixed order still knows.
    expect(m.body()).toEqual({
      provider: null,
      model: null,
      resolved: {
        leader: { provider: 'anthropic', model: 'claude-sonnet-5' },
        specialist: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      },
    })
  })

  it('GET names the pulled Ollama model the deploy will use, not an unpulled pick', async () => {
    setKeylessProviderChoice('ollama', true)
    __resetOllamaModelsCacheForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ models: [{ name: 'qwen2.5:7b', capabilities: ['completion', 'tools'] }] }),
      ),
    )
    try {
      onboardingNativeLeaderModelPOST(
        req({ provider: 'ollama', model: 'mistral-nemo' }),
        mockRes().res,
      )
      const m = mockRes()
      await onboardingNativeLeaderModelGET(req({}), m.res)
      expect(m.body()).toEqual({
        provider: 'ollama',
        model: 'mistral-nemo',
        resolved: {
          leader: { provider: 'ollama', model: 'qwen2.5:7b' },
          specialist: { provider: 'ollama', model: 'qwen2.5:7b' },
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('POST retro-applies the pick to an EXISTING native Boo Zero AgentConfig', () => {
    const db = getDb()
    // Seed a native Boo Zero + its stored AgentConfig (the shape ensureNativeBooZero writes).
    setSetting(db, SETTING_NATIVE_BOO_ZERO_ID, 'native-bz-1')
    saveAgentConfig(db, {
      ...DEFAULT_AGENT_CONFIG,
      id: 'native-bz-1',
      name: 'Boo Zero',
      primaryProvider: 'anthropic',
      primaryModel: 'claude-haiku-4-5',
      envVar: 'ANTHROPIC_API_KEY',
    })

    const m = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'openrouter', model: 'minimax/m2.5' }), m.res)
    expect(m.statusCode()).toBe(200)

    // The EXISTING leader now runs the pick — not just future lazily-created ones.
    const cfg = loadAgentConfig(db, 'native-bz-1')
    expect(cfg?.primaryProvider).toBe('openrouter')
    expect(cfg?.primaryModel).toBe('minimax/m2.5')
    expect(cfg?.envVar).toBe('OPENROUTER_API_KEY')
  })
})
