// POST /api/system/auto-configure-openclaw: the Ollama rung. A user whose native
// provider is their local Ollama gets OpenClaw configured on it (the local marker,
// a pulled default model) instead of a prompt for a cloud key. It is the last
// resort: a key, an OpenClaw subscription profile and the ChatGPT sign-in offer
// for a codex-CLI login all come first. The response says whether the default
// model is pulled. Every write is non-destructive. The Ollama daemon is a
// stubbed fetch.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const codexAuthState = vi.hoisted(() => ({ loggedIn: false }))
vi.mock('../../lib/runtimes/codexAuth', () => ({
  isCodexLoggedIn: () => Promise.resolve(codexAuthState.loggedIn),
  invalidateCodexAuthCache: () => {},
  userCodexHome: () => '/nonexistent/.codex',
  userCodexAuthPath: () => '/nonexistent/.codex/auth.json',
}))

import { __resetOllamaModelsCacheForTests } from '../../lib/runtimes/native/ollamaModels'
import {
  setKeylessProviderChoice,
  setRuntimeDisconnected,
  setRuntimeSecret,
} from '../../lib/secretsVault'
import { autoConfigureOpenclawPOST } from '../system'

function mockRes(): { res: Response; body: () => Record<string, unknown> } {
  let payload: unknown
  const res = {
    status() {
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, body: () => payload as Record<string, unknown> }
}

describe('POST /api/system/auto-configure-openclaw: the Ollama rung', () => {
  let home: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}
  const fetchMock = vi.fn()

  function serveTags(...names: string[]): void {
    const models = [
      { name: 'nomic-embed-text:latest', capabilities: ['embedding'] },
      ...names.map((name) => ({ name, capabilities: ['completion', 'tools'] })),
    ]
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ models }), { status: 200 }))
  }

  async function autoConfigure(): Promise<Record<string, unknown>> {
    const r = mockRes()
    await autoConfigureOpenclawPOST({ body: {} } as unknown as Request, r.res)
    return r.body()
  }

  const envPath = (): string => path.join(stateDir, '.env')
  const configPath = (): string => path.join(stateDir, 'openclaw.json')
  const readEnv = (): string => readFileSync(envPath(), 'utf8')
  const readConfig = (): Record<string, unknown> =>
    JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>
  const primaryOf = (config: Record<string, unknown>): unknown =>
    (config['agents'] as { defaults: { model: { primary: unknown } } }).defaults.model.primary

  function writeState(file: string, content: string): void {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, file), content)
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-auto-ollama-'))
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR', 'OLLAMA_BASE_URL']) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['OLLAMA_BASE_URL']
    codexAuthState.loggedIn = false
    __resetOllamaModelsCacheForTests()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    serveTags('llama3.2:latest')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  // ── when the rung fires ─────────────────────────────────────────────────────
  it('configures OpenClaw on a chosen Ollama: the marker, a gateway token, a pulled default', async () => {
    setKeylessProviderChoice('ollama', true)
    const body = await autoConfigure()
    expect(body).toEqual({
      ok: true,
      gatewayUrl: 'ws://localhost:18789',
      provider: 'ollama',
      model: 'ollama/llama3.2',
      modelPulled: true,
    })

    const env = readEnv().split('\n')
    expect(env).toContain('OLLAMA_API_KEY=ollama-local')
    expect(env.some((l) => /^GATEWAY_AUTH_TOKEN=[a-f0-9]{64}$/.test(l))).toBe(true)
    expect(primaryOf(readConfig())).toBe('ollama/llama3.2')
    // OLLAMA_BASE_URL unset: OpenClaw stays on its own default Ollama.
    expect(readConfig()['models']).toBeUndefined()
  })

  it('defaults to a model Ollama has pulled, not the static llama3.2', async () => {
    setKeylessProviderChoice('ollama', true)
    serveTags('qwen2.5:7b')
    await autoConfigure()
    expect(primaryOf(readConfig())).toBe('ollama/qwen2.5:7b')
  })

  it('fires for an OLLAMA_BASE_URL user with no recorded choice, pointing OpenClaw at that Ollama', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://127.0.0.1:18979/v1'
    expect((await autoConfigure())['provider']).toBe('ollama')
    // The native root: OpenClaw calls /api/*, never /v1.
    expect(readConfig()['models']).toEqual({
      providers: { ollama: { baseUrl: 'http://127.0.0.1:18979' } },
    })
  })

  // ── where it sits ───────────────────────────────────────────────────────────
  it('a connected key still wins over Ollama, and gets no Ollama marker', async () => {
    setKeylessProviderChoice('ollama', true)
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-vault')
    const body = await autoConfigure()
    expect(body['provider']).toBe('anthropic')
    expect(readEnv()).toContain('ANTHROPIC_API_KEY=sk-ant-vault')
    expect(readEnv()).not.toContain('OLLAMA_API_KEY')
    expect(primaryOf(readConfig())).toBe('anthropic/claude-sonnet-4-5')
  })

  it('an OpenClaw subscription profile still wins over Ollama', async () => {
    setKeylessProviderChoice('ollama', true)
    const dir = path.join(stateDir, 'agents', 'main', 'agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'auth-profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: {
          'openai-codex:default': { type: 'oauth', provider: 'openai-codex', access: 'at' },
        },
      }),
    )
    const body = await autoConfigure()
    expect(body['provider']).toBe('openai-codex')
    expect(readEnv()).not.toContain('OLLAMA_API_KEY')
    expect(primaryOf(readConfig())).toBe('openai-codex/gpt-5.5')
  })

  it('a codex-CLI login comes before Ollama: the ChatGPT sign-in is offered, nothing written', async () => {
    setKeylessProviderChoice('ollama', true)
    codexAuthState.loggedIn = true
    const body = await autoConfigure()
    expect(body['needsCodexAuth']).toBe(true)
    expect(existsSync(envPath())).toBe(false)
    expect(existsSync(configPath())).toBe(false)
  })

  // ── when it does not fire ───────────────────────────────────────────────────
  it('no rung once Ollama was removed, even with OLLAMA_BASE_URL set: nothing is written', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://127.0.0.1:11434/v1'
    setKeylessProviderChoice('ollama', false)
    expect(await autoConfigure()).toEqual({ ok: false, needsKey: true })
    expect(existsSync(envPath())).toBe(false)
    expect(existsSync(configPath())).toBe(false)
  })

  it('no rung after the native runtime was disconnected (its choice forgotten)', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://127.0.0.1:11434/v1'
    // A full runtime disconnect forgets the choice and records the disconnect.
    setKeylessProviderChoice('ollama', null)
    setRuntimeDisconnected('clawboo-native', true)
    expect(await autoConfigure()).toEqual({ ok: false, needsKey: true })
    expect(existsSync(envPath())).toBe(false)
  })

  // ── whether the default can run ─────────────────────────────────────────────
  it('with no chat model pulled, says the default is missing and how to pull it', async () => {
    setKeylessProviderChoice('ollama', true)
    serveTags()
    const body = await autoConfigure()
    expect(body['ok']).toBe(true)
    expect(body['model']).toBe('ollama/llama3.2')
    expect(body['modelPulled']).toBe(false)
    expect(body['pullCommand']).toBe('ollama pull llama3.2')
  })

  it('a call right after the pull sees it (Check again)', async () => {
    setKeylessProviderChoice('ollama', true)
    serveTags()
    expect((await autoConfigure())['modelPulled']).toBe(false)
    serveTags('llama3.2:latest')
    const body = await autoConfigure()
    expect(body['modelPulled']).toBe(true)
    expect('pullCommand' in body).toBe(false)
  })

  it('a fresh pick asks Ollama once', async () => {
    setKeylessProviderChoice('ollama', true)
    await autoConfigure()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an Ollama that is not answering counts as not pulled', async () => {
    setKeylessProviderChoice('ollama', true)
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const body = await autoConfigure()
    expect(body['modelPulled']).toBe(false)
    expect(body['pullCommand']).toBe('ollama pull llama3.2')
  })

  it('checks a kept Ollama primary, not the model a fresh pick would get', async () => {
    setKeylessProviderChoice('ollama', true)
    serveTags('qwen2.5:7b')
    writeState(
      'openclaw.json',
      JSON.stringify({ agents: { defaults: { model: { primary: 'ollama/mistral:7b' } } } }),
    )
    const body = await autoConfigure()
    expect(body['model']).toBe('ollama/mistral:7b')
    expect(body['modelPulled']).toBe(false)
    expect(body['pullCommand']).toBe('ollama pull mistral:7b')
  })

  it('says nothing about a kept primary on another provider', async () => {
    setKeylessProviderChoice('ollama', true)
    writeState(
      'openclaw.json',
      JSON.stringify({ agents: { defaults: { model: { primary: 'anthropic/claude-x' } } } }),
    )
    const body = await autoConfigure()
    expect(body['provider']).toBe('ollama')
    expect('model' in body).toBe(false)
    expect('modelPulled' in body).toBe(false)
  })

  it('the key rung carries no model status, even over a kept Ollama primary', async () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-vault')
    serveTags()
    writeState(
      'openclaw.json',
      JSON.stringify({ agents: { defaults: { model: { primary: 'ollama/llama3.2' } } } }),
    )
    const body = await autoConfigure()
    expect(body['provider']).toBe('anthropic')
    expect('modelPulled' in body).toBe(false)
  })

  // ── non-destructive ─────────────────────────────────────────────────────────
  it('never replaces a primary model the user already has', async () => {
    setKeylessProviderChoice('ollama', true)
    serveTags('qwen2.5:7b')
    writeState(
      'openclaw.json',
      JSON.stringify({ agents: { defaults: { model: { primary: 'ollama/mistral:7b' } } } }),
    )
    await autoConfigure()
    expect(primaryOf(readConfig())).toBe('ollama/mistral:7b')
  })

  it('keeps an OLLAMA_API_KEY that has a value, and leaves the rest of .env as it was', async () => {
    setKeylessProviderChoice('ollama', true)
    const before = 'OTHER=1\nGATEWAY_AUTH_TOKEN=tok\nOLLAMA_API_KEY=my-own-key\n'
    writeState('.env', before)
    await autoConfigure()
    expect(readEnv()).toBe(before)
  })

  it('adds the marker below the existing lines, filling a blank OLLAMA_API_KEY in place', async () => {
    setKeylessProviderChoice('ollama', true)
    writeState('.env', 'OTHER=1\nGATEWAY_AUTH_TOKEN=tok\n')
    await autoConfigure()
    expect(readEnv()).toBe('OTHER=1\nGATEWAY_AUTH_TOKEN=tok\nOLLAMA_API_KEY=ollama-local\n')

    writeState('.env', 'OLLAMA_API_KEY=\nGATEWAY_AUTH_TOKEN=tok\n')
    await autoConfigure()
    expect(readEnv()).toBe('OLLAMA_API_KEY=ollama-local\nGATEWAY_AUTH_TOKEN=tok\n')
  })

  it('leaves an Ollama provider entry the user already configured', async () => {
    setKeylessProviderChoice('ollama', true)
    process.env['OLLAMA_BASE_URL'] = 'http://127.0.0.1:18979/v1'
    const mine = { baseUrl: 'http://gpu-box:11434', models: [] }
    writeState(
      'openclaw.json',
      JSON.stringify({ models: { mode: 'merge', providers: { ollama: mine } } }),
    )
    await autoConfigure()
    expect(readConfig()['models']).toEqual({ mode: 'merge', providers: { ollama: mine } })
  })
})
