// POST /api/system/configure-openclaw mints a gateway token and persists it
// server-side, but must NOT echo it in the response body (the same contract as
// GET /api/settings — the proxy injects the token server-side). Real path: drives
// the actual handler against a sandboxed state dir and inspects both the response
// and the on-disk .env.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetOllamaModelsCacheForTests } from '../../lib/runtimes/native/ollamaModels'
import { configureOpenclawPOST } from '../system'

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
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

describe('POST /api/system/configure-openclaw — token not echoed', () => {
  let home: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-cfg-'))
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR']) saved[k] = process.env[k]
    process.env['CLAWBOO_HOME'] = home
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('persists the token to .env but omits it from the response', async () => {
    const r = mockRes()
    await configureOpenclawPOST(
      { body: { provider: 'anthropic', apiKey: 'sk-test-key' } } as unknown as Request,
      r.res,
    )

    expect(r.statusCode()).toBe(200)
    const body = r.body() as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['gatewayUrl']).toBe('ws://localhost:18789')
    // The leak is closed — no raw token in the response body.
    expect('gatewayToken' in body).toBe(false)

    // …but the token WAS persisted server-side (the real save happened).
    const env = readFileSync(path.join(stateDir, '.env'), 'utf8')
    const match = env.match(/GATEWAY_AUTH_TOKEN=([a-f0-9]{64})/)
    expect(match).not.toBeNull()
    const persistedToken = match![1]!
    // The persisted token must not appear anywhere in the HTTP response.
    expect(JSON.stringify(body)).not.toContain(persistedToken)
  })
})

// Ollama through OpenClaw: OpenClaw registers its `ollama` provider only with a
// credential, and runs only a model the daemon has pulled. Without either, every
// Gateway run failed as "Unknown model: ollama/llama3.2". The daemon is a stubbed
// fetch here.
describe('POST /api/system/configure-openclaw: Ollama', () => {
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

  async function configure(body: Record<string, unknown>): Promise<{
    status: number
    config: Record<string, unknown>
    env: string
  }> {
    const r = mockRes()
    await configureOpenclawPOST({ body } as unknown as Request, r.res)
    return {
      status: r.statusCode(),
      config: JSON.parse(readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')) as Record<
        string,
        unknown
      >,
      env: readFileSync(path.join(stateDir, '.env'), 'utf8'),
    }
  }

  const primaryOf = (config: Record<string, unknown>): unknown =>
    (config['agents'] as { defaults: { model: { primary: unknown } } }).defaults.model.primary

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-cfg-ollama-'))
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR', 'OLLAMA_BASE_URL']) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = home
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['OLLAMA_BASE_URL']
    __resetOllamaModelsCacheForTests()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('writes the local marker so OpenClaw registers its Ollama provider', async () => {
    serveTags('llama3.2:latest')
    const { status, env } = await configure({ provider: 'ollama' })
    expect(status).toBe(200)
    expect(env.split('\n')).toContain('OLLAMA_API_KEY=ollama-local')
    expect(env).not.toContain('CUSTOM_API_KEY')
  })

  it('swaps the picker default for a model Ollama has pulled', async () => {
    serveTags('qwen2.5:7b')
    const { config } = await configure({ provider: 'ollama', model: 'ollama/llama3.3' })
    expect(primaryOf(config)).toBe('ollama/qwen2.5:7b')
  })

  it('keeps a chosen model Ollama has pulled', async () => {
    serveTags('qwen2.5:7b', 'mistral:latest')
    const { config } = await configure({ provider: 'ollama', model: 'ollama/mistral' })
    expect(primaryOf(config)).toBe('ollama/mistral')
  })

  it('defaults to llama3.2 when it is pulled and no model is sent', async () => {
    // aya sorts ahead of llama, so only the llama3.2 preference can pick llama3.2.
    serveTags('aya-expanse:8b', 'llama3.2:latest')
    const { config } = await configure({ provider: 'ollama' })
    expect(primaryOf(config)).toBe('ollama/llama3.2')
  })

  it('still configures when Ollama is not answering', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const { status, config, env } = await configure({ provider: 'ollama' })
    expect(status).toBe(200)
    expect(primaryOf(config)).toBe('ollama/llama3.2')
    expect(env).toContain('OLLAMA_API_KEY=ollama-local')
  })

  it('points OpenClaw at OLLAMA_BASE_URL, which it never reads itself', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://gpu-box.local:11434/v1'
    serveTags('qwen2.5:7b')
    const { config } = await configure({ provider: 'ollama' })
    expect(config['models']).toEqual({
      providers: { ollama: { baseUrl: 'http://gpu-box.local:11434' } },
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://gpu-box.local:11434/api/tags')
  })

  it('leaves OpenClaw on its default endpoint without OLLAMA_BASE_URL', async () => {
    serveTags('llama3.2:latest')
    const { config } = await configure({ provider: 'ollama' })
    expect('models' in config).toBe(false)
  })

  it('leaves every other provider alone', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://gpu-box.local:11434/v1'
    const { config, env } = await configure({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'anthropic/claude-sonnet-4-5',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(primaryOf(config)).toBe('anthropic/claude-sonnet-4-5')
    expect('models' in config).toBe(false)
    expect(env).not.toContain('OLLAMA_API_KEY')
  })
})
