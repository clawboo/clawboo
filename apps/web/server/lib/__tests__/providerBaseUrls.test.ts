// A provider pointed at a gateway is reached there by all three: the runs, the
// key check and the model list. Before, only Anthropic's and OpenAI's runs could
// be moved, and the key check and the model list always called the public
// address, so behind a gateway a good key read as bad and the list was empty.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '@clawboo/adapter-native'

const built = vi.hoisted(() => ({
  anthropic: [] as Array<{ apiKey: string; baseURL?: string }>,
  openai: [] as Array<{ apiKey: string; baseURL?: string }>,
  openaiBodies: [] as Array<Record<string, unknown>>,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(opts: { apiKey: string; baseURL?: string }) {
      built.anthropic.push(opts)
    }
    messages = {
      create: async () =>
        (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 1 } } }
        })(),
    }
  },
}))

vi.mock('openai', () => ({
  default: class {
    constructor(opts: { apiKey: string; baseURL?: string }) {
      built.openai.push(opts)
    }
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          built.openaiBodies.push(params)
          return (async function* () {})()
        },
      },
    }
  },
}))

const { initOperatorSettings, OperatorSettingsError, resetOperatorSettings } =
  await import('../operatorSettings')
const {
  loadProviderBaseUrls,
  providerBaseUrl,
  providerBaseUrlOverride,
  providerBaseUrlWarnings,
  resetProviderBaseUrls,
} = await import('../providerBaseUrls')
const { createRoutedClient } = await import('../runtimes/native/routeCall')
const { fetchNativeModelsForKey } = await import('../providerModels')
const { fetchOpenRouterModels } = await import('../openrouterModels')

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-base-urls-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAWBOO_HOME', home)
  for (const name of [
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'OPENROUTER_BASE_URL',
    'GROQ_BASE_URL',
    'CLAWBOO_OPERATOR_SETTINGS',
  ]) {
    vi.stubEnv(name, '')
  }
  resetOperatorSettings()
  resetProviderBaseUrls()
  built.anthropic.length = 0
  built.openai.length = 0
  built.openaiBodies.length = 0
})
afterEach(() => {
  resetOperatorSettings()
  resetProviderBaseUrls()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

const operatorFile = (doc: Record<string, unknown>): void =>
  writeFileSync(path.join(home, 'operator.json'), JSON.stringify(doc))

describe('the base URL in force', () => {
  it("is each provider's own address with nothing set", () => {
    expect(providerBaseUrl('anthropic')).toBe('https://api.anthropic.com')
    expect(providerBaseUrl('openai')).toBe('https://api.openai.com/v1')
    expect(providerBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1')
    expect(providerBaseUrl('groq')).toBe('https://api.groq.com/openai/v1')
    expect(providerBaseUrlOverride('anthropic')).toBeNull()
    expect(providerBaseUrlOverride('ollama')).toBeNull()
  })

  it('comes from the variable, without a trailing slash', () => {
    vi.stubEnv('GROQ_BASE_URL', 'https://gw.example.com/groq/v1/')
    expect(providerBaseUrl('groq')).toBe('https://gw.example.com/groq/v1')
  })

  it('comes from the operator file once loaded, and the variable wins over it', () => {
    operatorFile({
      openrouterBaseUrl: 'https://gw.example.com/openrouter/v1',
      groqBaseUrl: 'https://file.example.com/v1',
    })
    vi.stubEnv('GROQ_BASE_URL', 'https://env.example.com/v1')
    initOperatorSettings()
    loadProviderBaseUrls()
    expect(providerBaseUrl('openrouter')).toBe('https://gw.example.com/openrouter/v1')
    expect(providerBaseUrl('groq')).toBe('https://env.example.com/v1')
    expect(providerBaseUrl('mistral')).toBe('https://api.mistral.ai/v1')
  })

  it('refuses to start on a base URL that carries credentials', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://user:pass@gw.example.com/v1')
    expect(() => initOperatorSettings()).toThrow(OperatorSettingsError)
  })
})

describe('startup warnings', () => {
  it('warn about a key sent over plain http to another machine, not to this one', () => {
    vi.stubEnv('OPENROUTER_BASE_URL', 'http://litellm.internal:4000/v1')
    vi.stubEnv('GROQ_BASE_URL', 'http://localhost:4000/v1')
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.example.com/v1')
    const warnings = providerBaseUrlWarnings(() => false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/OPENROUTER_BASE_URL sends the openrouter API key unencrypted/)
  })

  it('warn when a base URL comes from an operator file an agent could change', () => {
    operatorFile({ anthropicBaseUrl: 'https://gw.example.com' })
    initOperatorSettings()
    expect(providerBaseUrlWarnings(() => false)).toEqual([])
    expect(providerBaseUrlWarnings(() => true)[0]).toMatch(
      /anthropicBaseUrl come from an operator file this server's own user can change/,
    )
    expect(providerBaseUrlWarnings(() => null)[0]).toMatch(/cannot check on Windows/)
  })

  it('say nothing when no base URL is set', () => {
    expect(providerBaseUrlWarnings(() => true)).toEqual([])
  })
})

describe('runs', () => {
  const config = (provider: string, model: string, envVar: string): AgentConfig => ({
    ...DEFAULT_AGENT_CONFIG,
    id: 'native-base-url-test',
    primaryProvider: provider,
    primaryModel: model,
    envVar,
    fallbacks: [],
  })
  const turn = async (cfg: AgentConfig): Promise<void> => {
    const client = createRoutedClient(cfg, undefined, {
      resolveKey: () => 'sk-test',
      ollamaAllowed: false,
    })
    const it = client.streamTurn({
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      maxOutputTokens: 64,
      signal: new AbortController().signal,
    })
    for await (const ev of it) void ev
  }

  it("leave Anthropic and OpenAI on their SDKs' own address when nothing is set", async () => {
    await turn(config('anthropic', 'claude-haiku-4-5', 'ANTHROPIC_API_KEY'))
    await turn(config('openai', 'gpt-4o-mini', 'OPENAI_API_KEY'))
    expect(built.anthropic[0]).toEqual({ apiKey: 'sk-test' })
    expect(built.openai[0]).toEqual({ apiKey: 'sk-test' })
  })

  it("send each provider's requests to the base URL set for it", async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gw.example.com/anthropic')
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://gw.example.com/openrouter/v1')
    vi.stubEnv('GROQ_BASE_URL', 'https://gw.example.com/groq/v1')
    await turn(config('anthropic', 'claude-haiku-4-5', 'ANTHROPIC_API_KEY'))
    await turn(config('openrouter', 'openai/gpt-4o-mini', 'OPENROUTER_API_KEY'))
    await turn(config('groq', 'llama-3.3-70b-versatile', 'GROQ_API_KEY'))
    expect(built.anthropic[0]?.baseURL).toBe('https://gw.example.com/anthropic')
    expect(built.openai.map((o) => o.baseURL)).toEqual([
      'https://gw.example.com/openrouter/v1',
      'https://gw.example.com/groq/v1',
    ])
  })

  it("keep OpenAI's own token limit parameter through a gateway", async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.example.com/openai/v1')
    await turn(config('openai', 'gpt-5-mini', 'OPENAI_API_KEY'))
    await turn(config('groq', 'llama-3.3-70b-versatile', 'GROQ_API_KEY'))
    expect(built.openai[0]?.baseURL).toBe('https://gw.example.com/openai/v1')
    expect(built.openaiBodies[0]).toMatchObject({ max_completion_tokens: 64 })
    expect(built.openaiBodies[0]).not.toHaveProperty('max_tokens')
    expect(built.openaiBodies[1]).toMatchObject({ max_tokens: 64 })
  })
})

describe('model lists', () => {
  const answering = (body: unknown) =>
    vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body))

  it("read each provider's list at its base URL, and fetch again when it changes", async () => {
    const fetchMock = answering({ data: [{ id: 'llama-3.3-70b-versatile' }] })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('GROQ_BASE_URL', 'https://gw.example.com/groq/v1')
    expect(await fetchNativeModelsForKey('groq', 'gsk-test')).toEqual([
      { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile' },
    ])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gw.example.com/groq/v1/models')
    vi.stubEnv('GROQ_BASE_URL', 'https://other.example.com/v1')
    await fetchNativeModelsForKey('groq', 'gsk-test')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://other.example.com/v1/models')
  })

  it("read Anthropic's and OpenAI's lists at their base URLs too", async () => {
    const fetchMock = answering({ data: [{ id: 'gpt-4o' }] })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gw.example.com/anthropic')
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.example.com/openai/v1')
    await fetchNativeModelsForKey('anthropic', 'sk-ant-test')
    await fetchNativeModelsForKey('openai', 'sk-test')
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://gw.example.com/anthropic/v1/models?limit=100',
      'https://gw.example.com/openai/v1/models',
    ])
  })

  it("read OpenRouter's list at its base URL, starting over when it changes", async () => {
    const fetchMock = answering({ data: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }] })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://gw.example.com/openrouter/v1')
    expect(await fetchOpenRouterModels()).toEqual([
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
    ])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gw.example.com/openrouter/v1/models')
    vi.stubEnv('OPENROUTER_BASE_URL', '')
    await fetchOpenRouterModels()
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://openrouter.ai/api/v1/models')
  })
})
