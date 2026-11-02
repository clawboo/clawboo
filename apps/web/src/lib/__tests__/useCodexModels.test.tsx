// The ChatGPT plan's live models in the pickers: the OpenClaw-format group, the
// merge into a catalog (no hardcoded fallback, so an unknown list drops the empty
// group), and the shared fetch behind the hook.

import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../__vitest__/mswServer'
import { MODEL_GROUPS, type ModelGroup } from '../modelCatalog'
import {
  mergeCodexGroup,
  openClawCodexGroup,
  resetCodexModelsCache,
  useCodexModels,
} from '../useCodexModels'

const LIVE = [
  { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
]

describe('openClawCodexGroup', () => {
  it('routes each live id through `openai-codex/` under the catalog group name', () => {
    expect(openClawCodexGroup(LIVE)).toEqual({
      provider: 'OpenAI Codex',
      models: [
        { id: 'openai-codex/gpt-6-astra', label: 'GPT-6-Astra' },
        { id: 'openai-codex/gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      ],
    })
  })
})

describe('mergeCodexGroup', () => {
  const anthropic: ModelGroup = {
    provider: 'Anthropic',
    models: [{ id: 'anthropic/x', label: 'X' }],
  }

  it('fills the static (empty) group in place, keeping the order of the rest', () => {
    const base: ModelGroup[] = [anthropic, { provider: 'OpenAI Codex', models: [] }]
    expect(mergeCodexGroup(base, LIVE)).toEqual([anthropic, openClawCodexGroup(LIVE)])
  })

  it('replaces a CLI-listed group under its lowercase id too (slug match)', () => {
    const base: ModelGroup[] = [
      { provider: 'openai-codex', models: [{ id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' }] },
    ]
    expect(mergeCodexGroup(base, LIVE)).toEqual([openClawCodexGroup(LIVE)])
  })

  it('appends the group when the base has none', () => {
    expect(mergeCodexGroup([anthropic], LIVE)).toEqual([anthropic, openClawCodexGroup(LIVE)])
  })

  it('with the list unknown, drops the empty group and keeps a non-empty one', () => {
    expect(mergeCodexGroup(MODEL_GROUPS, []).some((g) => g.provider === 'OpenAI Codex')).toBe(false)
    const listed: ModelGroup = {
      provider: 'OpenAI Codex',
      models: [{ id: 'openai-codex/gpt-6-sol', label: 'GPT-6-Sol' }],
    }
    expect(mergeCodexGroup([listed], [])).toEqual([listed])
  })
})

describe('useCodexModels', () => {
  afterEach(() => {
    resetCodexModelsCache()
  })

  it('serves the live list from the server', async () => {
    server.use(
      http.get('/api/runtimes/codex/models', () =>
        HttpResponse.json({ models: LIVE, defaultModel: 'gpt-6-astra', updateRequired: false }),
      ),
    )
    const { result } = renderHook(() => useCodexModels())
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.models).toEqual(LIVE))
    expect(result.current.isLoading).toBe(false)
  })

  it('is empty on a server failure (no hardcoded fallback)', async () => {
    let calls = 0
    server.use(
      http.get('/api/runtimes/codex/models', () => {
        calls += 1
        return new HttpResponse(null, { status: 500 })
      }),
    )
    const { result } = renderHook(() => useCodexModels())
    await waitFor(() => expect(calls).toBe(1))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.models).toEqual([])
  })

  it('asks again after a minute when the list came back empty, not after five', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let calls = 0
      server.use(
        http.get('/api/runtimes/codex/models', () => {
          calls += 1
          return HttpResponse.json(
            calls === 1
              ? { models: [], defaultModel: null, updateRequired: false }
              : { models: LIVE, defaultModel: 'gpt-6-astra', updateRequired: false },
          )
        }),
      )
      const first = renderHook(() => useCodexModels())
      await waitFor(() => expect(first.result.current.isLoading).toBe(false))
      expect(first.result.current.models).toEqual([])
      first.unmount()

      vi.setSystemTime(Date.now() + 61 * 1000)
      const second = renderHook(() => useCodexModels())
      await waitFor(() => expect(second.result.current.models).toEqual(LIVE))
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fetch when disabled', async () => {
    let calls = 0
    server.use(
      http.get('/api/runtimes/codex/models', () => {
        calls += 1
        return HttpResponse.json({ models: LIVE })
      }),
    )
    const { result } = renderHook(() => useCodexModels(false))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(0)
    expect(result.current).toEqual({ models: [], isLoading: false })
  })
})
