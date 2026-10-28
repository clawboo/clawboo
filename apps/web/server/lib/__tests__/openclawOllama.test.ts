// The default model and endpoint clawboo hands OpenClaw's Ollama provider. A
// default Ollama hasn't pulled fails every OpenClaw run as an unknown model,
// which is what `configure-openclaw` used to write on this machine (only
// nomic-embed-text pulled). Every fetch is stubbed; nothing reaches a daemon.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OPENCLAW_OLLAMA_KEY_LINE,
  openclawOllamaProviderConfig,
  resolveOpenclawOllamaModel,
} from '../openclawOllama'
import { __resetOllamaModelsCacheForTests } from '../runtimes/native/ollamaModels'

const NOMIC = {
  name: 'nomic-embed-text:latest',
  modified_at: '2026-09-25T00:00:00Z',
  details: { family: 'nomic-bert' },
  capabilities: ['embedding'],
}

function tag(name: string, caps: string[], modified: string): Record<string, unknown> {
  return { name, modified_at: modified, details: { family: 'llama' }, capabilities: caps }
}

const QWEN = tag('qwen2.5:7b', ['completion', 'tools'], '2026-10-01T00:00:00Z')
const GEMMA = tag('gemma2:latest', ['completion'], '2026-10-20T00:00:00Z')
const LLAMA = tag('llama3.2:latest', ['completion', 'tools'], '2026-09-01T00:00:00Z')

const fetchMock = vi.fn()

function serveTags(...models: unknown[]): void {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ models }), { status: 200 }))
}

beforeEach(() => {
  __resetOllamaModelsCacheForTests()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('OLLAMA_BASE_URL', '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('resolveOpenclawOllamaModel', () => {
  it('keeps a requested model Ollama has pulled', async () => {
    serveTags(NOMIC, QWEN, LLAMA)
    expect(await resolveOpenclawOllamaModel('ollama/llama3.2')).toBe('ollama/llama3.2')
  })

  it('swaps a requested model Ollama lacks for a pulled one that can use tools', async () => {
    // gemma2 is newer but can't call tools, which agents offer on nearly every turn.
    serveTags(NOMIC, QWEN, GEMMA)
    expect(await resolveOpenclawOllamaModel('ollama/llama3.3')).toBe('ollama/qwen2.5:7b')
  })

  it('always answers with the ollama/ prefix OpenClaw routes on', async () => {
    serveTags(QWEN)
    expect(await resolveOpenclawOllamaModel('qwen2.5:7b')).toBe('ollama/qwen2.5:7b')
  })

  it('prefers llama3.2 when nothing usable is requested', async () => {
    serveTags(QWEN, LLAMA)
    expect(await resolveOpenclawOllamaModel(undefined)).toBe('ollama/llama3.2')
    expect(await resolveOpenclawOllamaModel('  ')).toBe('ollama/llama3.2')
    expect(await resolveOpenclawOllamaModel('ollama/')).toBe('ollama/llama3.2')
  })

  it('keeps the request when Ollama has only an embedding model', async () => {
    serveTags(NOMIC)
    expect(await resolveOpenclawOllamaModel('ollama/llama3.3')).toBe('ollama/llama3.3')
  })

  it('keeps the request when Ollama is not answering', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    expect(await resolveOpenclawOllamaModel('ollama/llama3.2')).toBe('ollama/llama3.2')
  })

  it('asks the Ollama OLLAMA_BASE_URL names, at its native root', async () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://gpu-box.local:11434/v1')
    serveTags(QWEN)
    await resolveOpenclawOllamaModel('ollama/llama3.2')
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://gpu-box.local:11434/api/tags')
  })

  it('reads the pulled models afresh, so a model pulled a moment ago counts', async () => {
    serveTags(QWEN)
    expect(await resolveOpenclawOllamaModel('ollama/llama3.2')).toBe('ollama/qwen2.5:7b')
    serveTags(QWEN, LLAMA)
    expect(await resolveOpenclawOllamaModel('ollama/llama3.2')).toBe('ollama/llama3.2')
  })
})

describe('openclawOllamaProviderConfig', () => {
  it('leaves OpenClaw on its own default when OLLAMA_BASE_URL is unset or blank', () => {
    expect(openclawOllamaProviderConfig({})).toBeNull()
    expect(openclawOllamaProviderConfig({ OLLAMA_BASE_URL: '   ' })).toBeNull()
  })

  it('points OpenClaw at the native root of OLLAMA_BASE_URL', () => {
    expect(
      openclawOllamaProviderConfig({ OLLAMA_BASE_URL: 'http://gpu-box.local:11434/v1/' }),
    ).toEqual({ baseUrl: 'http://gpu-box.local:11434' })
    expect(openclawOllamaProviderConfig({ OLLAMA_BASE_URL: 'http://10.0.0.5:11434' })).toEqual({
      baseUrl: 'http://10.0.0.5:11434',
    })
  })
})

describe('OPENCLAW_OLLAMA_KEY_LINE', () => {
  it('is the local marker OpenClaw accepts for a keyless Ollama', () => {
    expect(OPENCLAW_OLLAMA_KEY_LINE).toBe('OLLAMA_API_KEY=ollama-local')
  })
})
