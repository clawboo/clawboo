import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchExecConfigMap } from '../execConfigMap'

describe('fetchExecConfigMap', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns a Map of agentId → { execAsk } from API response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          configs: {
            a1: { execAsk: 'always' },
            a2: { execAsk: 'on-miss' },
          },
        }),
    })

    const map = await fetchExecConfigMap()
    expect(map.size).toBe(2)
    expect(map.get('a1')).toEqual({ execAsk: 'always' })
    expect(map.get('a2')).toEqual({ execAsk: 'on-miss' })
  })

  it('returns empty Map on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    const map = await fetchExecConfigMap()
    expect(map.size).toBe(0)
  })

  it('ignores entries without valid execAsk string', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          configs: {
            a1: { execAsk: 'always' },
            a2: { execAsk: 123 },
            a3: {},
            a4: null,
          },
        }),
    })

    const map = await fetchExecConfigMap()
    expect(map.size).toBe(1)
    expect(map.get('a1')).toEqual({ execAsk: 'always' })
  })

  it('returns empty Map when configs is missing from response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    })

    const map = await fetchExecConfigMap()
    expect(map.size).toBe(0)
  })
})
