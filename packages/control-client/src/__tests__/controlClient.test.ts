import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  apiFetch,
  apiUrl,
  connectRuntime,
  fetchOnboardingState,
  fetchRuntimes,
  getApiBase,
  listAgents,
  resetControlClient,
  seedNativeTeam,
  setApiBase,
  setNativeLeaderModel,
  setRequestHeaderProvider,
} from '../index'

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

afterEach(() => {
  resetControlClient()
  vi.restoreAllMocks()
})

describe('config seam', () => {
  it('defaults to same-origin (empty base) so apiUrl is byte-identical to the path', () => {
    expect(getApiBase()).toBe('')
    expect(apiUrl('/api/runtimes')).toBe('/api/runtimes')
  })

  it('setApiBase prefixes the path and strips a trailing slash', () => {
    setApiBase('https://host.example.com/')
    expect(getApiBase()).toBe('https://host.example.com')
    expect(apiUrl('/api/agents')).toBe('https://host.example.com/api/agents')
  })

  it('apiFetch injects the header provider and resolves the base URL', async () => {
    const fetchFn = stubFetch(async () => jsonResponse({}))
    setApiBase('https://host.example.com')
    setRequestHeaderProvider(() => ({ Authorization: 'Bearer tok', 'X-Tenant': 't1' }))

    await apiFetch('/api/x', { headers: { 'Content-Type': 'application/json' } })

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://host.example.com/api/x')
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'X-Tenant': 't1',
      // per-call header wins / coexists
      'Content-Type': 'application/json',
    })
  })

  it('resetControlClient restores the same-origin, no-header defaults', () => {
    setApiBase('https://x')
    setRequestHeaderProvider(() => ({ Authorization: 'nope' }))
    resetControlClient()
    expect(getApiBase()).toBe('')
    expect(apiUrl('/api/x')).toBe('/api/x')
  })
})

describe('runtimes client', () => {
  it('fetchRuntimes returns the list on ok', async () => {
    stubFetch(async () => jsonResponse({ runtimes: [{ id: 'clawboo-native' }] }))
    const list = await fetchRuntimes()
    expect(list).toEqual([{ id: 'clawboo-native' }])
  })

  it('fetchRuntimes falls back to [] on a non-ok response', async () => {
    stubFetch(async () => jsonResponse({}, { ok: false, status: 500 }))
    expect(await fetchRuntimes()).toEqual([])
  })

  it('fetchRuntimes falls back to [] and never throws when fetch rejects', async () => {
    stubFetch(async () => {
      throw new Error('network down')
    })
    expect(await fetchRuntimes()).toEqual([])
  })

  it('connectRuntime POSTs to the runtime connect path and returns ok', async () => {
    const fetchFn = stubFetch(async () => jsonResponse({ ok: true, connectionState: 'ready' }))
    const res = await connectRuntime('hermes', 'sk-abc', 'openrouter')
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/runtimes/hermes/connect')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ apiKey: 'sk-abc', provider: 'openrouter' })
    expect(res).toEqual({ ok: true, connectionState: 'ready' })
  })

  it('connectRuntime never throws on a network error', async () => {
    stubFetch(async () => {
      throw new Error('boom')
    })
    const res = await connectRuntime('codex', 'k')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })
})

describe('agents client', () => {
  it('listAgents throws on a non-ok response (jsonOrThrow)', async () => {
    stubFetch(async () => jsonResponse({ error: 'nope' }, { ok: false, status: 503 }))
    await expect(listAgents()).rejects.toThrow(/List agents failed \(503\): nope/)
  })
})

describe('onboarding client', () => {
  it('seedNativeTeam is defensive on error', async () => {
    stubFetch(async () => {
      throw new Error('down')
    })
    const res = await seedNativeTeam('anthropic')
    expect(res).toEqual({ ok: false, error: 'down' })
  })

  it('setNativeLeaderModel posts provider+model and returns ok; never throws', async () => {
    let body: unknown = null
    stubFetch(async (_url, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null
      return jsonResponse({ ok: true })
    })
    expect(await setNativeLeaderModel('anthropic', 'claude-sonnet-5')).toBe(true)
    expect(body).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })

    stubFetch(async () => {
      throw new Error('down')
    })
    expect(await setNativeLeaderModel('openai', 'gpt-5.4')).toBe(false)
  })

  it('fetchOnboardingState maps the four booleans', async () => {
    stubFetch(async () =>
      jsonResponse({ configured: false, hasNative: true, hasTeam: true, hasConnectedRuntime: false }),
    )
    expect(await fetchOnboardingState()).toEqual({
      configured: false,
      hasNative: true,
      hasTeam: true,
      hasConnectedRuntime: false,
    })
  })

  it('fetchOnboardingState reports the fresh-install shape on error', async () => {
    stubFetch(async () => jsonResponse({}, { ok: false, status: 500 }))
    expect(await fetchOnboardingState()).toEqual({
      configured: false,
      hasNative: false,
      hasTeam: false,
      hasConnectedRuntime: false,
    })
  })
})
