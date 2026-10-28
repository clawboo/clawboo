// What the local Ollama has pulled, and which of those models a new agent runs
// on. A model Ollama doesn't have fails every run with "model not found", and
// this machine's own Ollama (only nomic-embed-text pulled) is the case that
// motivated it: reachable, so the old reachability check passed, and still unable
// to run a single agent. Every fetch here is stubbed; nothing reaches a daemon.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetOllamaModelsCacheForTests,
  listOllamaModels,
  ollamaApiBase,
  ollamaModelOption,
  ollamaModelPulled,
  ollamaPullCommand,
  parseOllamaTags,
  pickOllamaModel,
  type OllamaModel,
} from '../ollamaModels'

/** One `/api/tags` entry in the shape Ollama 0.34 sends. */
function tag(
  name: string,
  opts: { caps?: string[] | null; family?: string; modified?: string } = {},
): Record<string, unknown> {
  return {
    name,
    model: name,
    modified_at: opts.modified ?? '2026-09-01T00:00:00Z',
    details: { family: opts.family ?? 'llama' },
    ...(opts.caps === null ? {} : { capabilities: opts.caps ?? ['completion', 'tools'] }),
  }
}

// Verbatim from this machine's Ollama, trimmed to the fields that matter.
const NOMIC = {
  name: 'nomic-embed-text:latest',
  model: 'nomic-embed-text:latest',
  modified_at: '2026-09-25T15:59:14.794654677-04:00',
  details: { family: 'nomic-bert', families: ['nomic-bert'] },
  capabilities: ['embedding'],
}

function model(id: string, tools: boolean | null, modifiedAt: number): OllamaModel {
  return { id, name: id.includes(':') ? id : `${id}:latest`, tools, modifiedAt }
}

describe('parseOllamaTags', () => {
  it('drops embedding-only models and keeps chat models', () => {
    const models = parseOllamaTags({ models: [NOMIC, tag('llama3.2:latest')] })
    expect(models?.map((m) => m.id)).toEqual(['llama3.2'])
  })

  it('reads an Ollama with only an embedding model as nothing to run', () => {
    expect(parseOllamaTags({ models: [NOMIC] })).toEqual([])
  })

  it('drops `:latest` from the id but keeps any other tag and the raw name', () => {
    const models = parseOllamaTags({ models: [tag('llama3.2:latest'), tag('qwen2.5:7b')] })
    expect(models?.map((m) => [m.id, m.name]).sort()).toEqual([
      ['llama3.2', 'llama3.2:latest'],
      ['qwen2.5:7b', 'qwen2.5:7b'],
    ])
  })

  it('lists the newest pull first', () => {
    const models = parseOllamaTags({
      models: [
        tag('old:latest', { modified: '2026-01-01T00:00:00Z' }),
        tag('new:latest', { modified: '2026-10-01T00:00:00Z' }),
      ],
    })
    expect(models?.map((m) => m.id)).toEqual(['new', 'old'])
  })

  it('records tool support from capabilities, and unknown when there are none', () => {
    const models = parseOllamaTags({
      models: [
        tag('a:latest', { caps: ['completion', 'tools'] }),
        tag('b:latest', { caps: ['completion'] }),
        tag('c:latest', { caps: null }),
      ],
    })
    const tools = Object.fromEntries((models ?? []).map((m) => [m.id, m.tools]))
    expect(tools).toEqual({ a: true, b: false, c: null })
  })

  it('without capabilities (an older Ollama), spots embedding models by family and name', () => {
    const models = parseOllamaTags({
      models: [
        tag('nomic-embed-text:latest', { caps: null, family: 'nomic-bert' }),
        tag('mxbai-embed-large:latest', { caps: null, family: 'bert' }),
        tag('all-minilm:latest', { caps: null, family: 'bert' }),
        tag('custom-vectors:latest', { caps: null, family: 'bert' }),
        tag('snowflake-arctic-embed2:latest', { caps: null, family: 'xlm-roberta' }),
        // Built on a chat family, so only its name gives it away.
        tag('qwen3-embedding:0.6b', { caps: null, family: 'qwen3' }),
        tag('llama3.2:latest', { caps: null, family: 'llama' }),
      ],
    })
    expect(models?.map((m) => m.id)).toEqual(['llama3.2'])
  })

  it('an empty capabilities list falls back to the name and family checks', () => {
    const models = parseOllamaTags({
      models: [tag('nomic-embed-text:latest', { caps: [] }), tag('llama3.2:latest', { caps: [] })],
    })
    expect(models?.map((m) => m.id)).toEqual(['llama3.2'])
  })

  it('returns null for a body that is not a tags list', () => {
    expect(parseOllamaTags(null)).toBeNull()
    expect(parseOllamaTags({ data: [] })).toBeNull()
    expect(parseOllamaTags('<html>')).toBeNull()
  })
})

describe('ollamaModelPulled', () => {
  const pulled = [model('llama3.2', true, 1), model('qwen2.5:7b', true, 2)]

  it('reads an untagged name as :latest, as Ollama does', () => {
    expect(ollamaModelPulled(pulled, 'llama3.2')).toBe(true)
    expect(ollamaModelPulled(pulled, 'llama3.2:latest')).toBe(true)
  })

  it('treats another tag as another model', () => {
    expect(ollamaModelPulled(pulled, 'llama3.2:1b')).toBe(false)
    expect(ollamaModelPulled(pulled, 'qwen2.5')).toBe(false)
    expect(ollamaModelPulled(pulled, 'qwen2.5:7b')).toBe(true)
  })
})

describe('pickOllamaModel', () => {
  it('keeps the preferred model when it is pulled', () => {
    const pulled = [model('qwen2.5:7b', true, 9), model('llama3.2', true, 1)]
    expect(pickOllamaModel('llama3.2', pulled)).toBe('llama3.2')
  })

  it('keeps the preferred model when nothing is known to be pulled', () => {
    expect(pickOllamaModel('llama3.2', [])).toBe('llama3.2')
  })

  it('otherwise takes the newest pulled model that can use tools', () => {
    const pulled = [
      model('gemma2', false, 30), // newest, but can't take a tool call
      model('qwen2.5:7b', true, 20),
      model('mistral', true, 10),
    ]
    expect(pickOllamaModel('llama3.2', pulled)).toBe('qwen2.5:7b')
  })

  it('prefers unknown tool support over known-missing', () => {
    const pulled = [model('gemma2', false, 30), model('mystery', null, 20)]
    expect(pickOllamaModel('llama3.2', pulled)).toBe('mystery')
  })

  it('falls back to the newest model when none can use tools', () => {
    const pulled = [model('gemma2', false, 30), model('phi3', false, 20)]
    expect(pickOllamaModel('llama3.2', pulled)).toBe('gemma2')
  })
})

describe('ollamaApiBase', () => {
  it('defaults to the local daemon', () => {
    expect(ollamaApiBase({})).toBe('http://localhost:11434')
  })

  it('strips the OpenAI-compatible /v1 suffix and any trailing slash', () => {
    expect(ollamaApiBase({ OLLAMA_BASE_URL: 'http://gpu-box:11434/v1' })).toBe(
      'http://gpu-box:11434',
    )
    expect(ollamaApiBase({ OLLAMA_BASE_URL: 'http://gpu-box:11434/v1/' })).toBe(
      'http://gpu-box:11434',
    )
    expect(ollamaApiBase({ OLLAMA_BASE_URL: ' http://gpu-box:11434/ ' })).toBe(
      'http://gpu-box:11434',
    )
  })
})

describe('labels and commands', () => {
  it('marks a model that cannot use tools, and only that one', () => {
    expect(ollamaModelOption(model('gemma2', false, 1)).label).toBe("gemma2 (can't use tools)")
    expect(ollamaModelOption(model('qwen2.5:7b', true, 1)).label).toBe('qwen2.5:7b')
    expect(ollamaModelOption(model('mystery', null, 1)).label).toBe('mystery')
  })

  it('prints the pull command without the implicit :latest', () => {
    expect(ollamaPullCommand('llama3.2:latest')).toBe('ollama pull llama3.2')
    expect(ollamaPullCommand('qwen2.5:7b')).toBe('ollama pull qwen2.5:7b')
  })
})

describe('listOllamaModels', () => {
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

  function stubTags(body: unknown, status = 200) {
    const fetchMock = vi.fn(async (_url: string) => Response.json(body, { status }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('asks the native /api/tags of the configured base URL', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://gpu-box:11434/v1'
    const fetchMock = stubTags({ models: [tag('llama3.2:latest')] })
    const list = await listOllamaModels()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gpu-box:11434/api/tags')
    expect(list.reachable).toBe(true)
    expect(list.models.map((m) => m.id)).toEqual(['llama3.2'])
  })

  it('is reachable with an empty list when only embedding models are pulled', async () => {
    stubTags({ models: [NOMIC] })
    expect(await listOllamaModels()).toEqual({ reachable: true, models: [] })
  })

  it('is unreachable when the daemon refuses, errors, or is not Ollama', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    expect(await listOllamaModels()).toEqual({ reachable: false, models: [] })
    stubTags({ error: 'boom' }, 500)
    expect(await listOllamaModels()).toEqual({ reachable: false, models: [] })
    stubTags({ hello: 'not ollama' })
    expect(await listOllamaModels()).toEqual({ reachable: false, models: [] })
  })

  it('asks again every time by default, so a fresh pull shows up', async () => {
    const fetchMock = stubTags({ models: [] })
    await listOllamaModels()
    await listOllamaModels()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reuses a recent answer within maxAgeMs, but not for another base URL', async () => {
    const fetchMock = stubTags({ models: [tag('llama3.2:latest')] })
    await listOllamaModels({ maxAgeMs: 10_000 })
    await listOllamaModels({ maxAgeMs: 10_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    process.env['OLLAMA_BASE_URL'] = 'http://gpu-box:11434'
    await listOllamaModels({ maxAgeMs: 10_000 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
