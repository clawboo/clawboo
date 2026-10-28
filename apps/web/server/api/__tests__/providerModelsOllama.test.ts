// GET /api/providers/ollama/models: the chat models the local Ollama has pulled,
// for the onboarding dropdown and the providers manager's Ollama row. Keyless, so
// unlike the keyed providers it never touches the vault. Every fetch is stubbed.

import type { Request, Response as ExpressResponse } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetOllamaModelsCacheForTests } from '../../lib/runtimes/native/ollamaModels'
import { providerModelsGET } from '../providers'

function call(id: string): Promise<unknown> {
  return new Promise((resolve) => {
    const res = { json: (b: unknown) => resolve(b) } as unknown as ExpressResponse
    void providerModelsGET({ params: { id } } as unknown as Request, res)
  })
}

function stubTags(models: Record<string, unknown>[]) {
  const fetchMock = vi.fn(async (_url: string) => Response.json({ models }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const NOMIC = {
  name: 'nomic-embed-text:latest',
  modified_at: '2026-10-09T00:00:00Z',
  details: { family: 'nomic-bert' },
  capabilities: ['embedding'],
}
const chat = (name: string, modified: string, caps = ['completion', 'tools']) => ({
  name,
  modified_at: modified,
  details: { family: 'llama' },
  capabilities: caps,
})

describe('GET /api/providers/ollama/models', () => {
  const saved = process.env['OLLAMA_BASE_URL']
  beforeEach(() => {
    delete process.env['OLLAMA_BASE_URL']
    __resetOllamaModelsCacheForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (saved === undefined) delete process.env['OLLAMA_BASE_URL']
    else process.env['OLLAMA_BASE_URL'] = saved
  })

  it('lists pulled chat models (no embedding models) and the model a new agent gets', async () => {
    stubTags([
      NOMIC,
      chat('gemma2:latest', '2026-10-05T00:00:00Z', ['completion']),
      chat('qwen2.5:7b', '2026-10-01T00:00:00Z'),
    ])
    expect(await call('ollama')).toEqual({
      models: [
        { id: 'gemma2', label: "gemma2 (can't use tools)" },
        { id: 'qwen2.5:7b', label: 'qwen2.5:7b' },
      ],
      reachable: true,
      recommendedModel: 'qwen2.5:7b',
    })
  })

  it('recommends llama3.2 whenever it is pulled', async () => {
    stubTags([
      chat('qwen2.5:7b', '2026-10-01T00:00:00Z'),
      chat('llama3.2:latest', '2026-01-01T00:00:00Z'),
    ])
    expect(await call('ollama')).toMatchObject({ recommendedModel: 'llama3.2' })
  })

  it('an Ollama with only an embedding model is reachable with nothing to list', async () => {
    stubTags([NOMIC])
    expect(await call('ollama')).toEqual({
      models: [],
      reachable: true,
      recommendedModel: 'llama3.2',
    })
  })

  it('a stopped Ollama reads unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    expect(await call('ollama')).toEqual({
      models: [],
      reachable: false,
      recommendedModel: 'llama3.2',
    })
  })

  it('reads fresh each time, so a model pulled a moment ago appears on the next look', async () => {
    const fetchMock = stubTags([NOMIC])
    await call('ollama')
    stubTags([chat('llama3.2:latest', '2026-10-10T00:00:00Z')])
    expect(await call('ollama')).toMatchObject({ models: [{ id: 'llama3.2' }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('an unsupported provider still answers an empty list without asking anyone', async () => {
    const fetchMock = stubTags([])
    expect(await call('not-a-provider')).toEqual({ models: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
