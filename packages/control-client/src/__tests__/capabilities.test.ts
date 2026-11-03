import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ENGINE_API_REVISION,
  engineCapabilitiesSchema,
  engineHasFeature,
  engineSupportsClient,
  fetchEngineCapabilities,
  resetControlClient,
  setApiBase,
  supportFloorFor,
  type EngineCapabilities,
} from '../index'

function caps(version: string, features: Record<string, boolean> = {}): EngineCapabilities {
  return {
    version,
    apiRevision: ENGINE_API_REVISION,
    supportFloor: supportFloorFor(version),
    features,
  }
}

afterEach(() => {
  resetControlClient()
  vi.restoreAllMocks()
})

describe('supportFloorFor', () => {
  it('is the previous minor of the same major', () => {
    expect(supportFloorFor('0.6.0')).toBe('0.5')
    expect(supportFloorFor('0.6.3')).toBe('0.5')
    expect(supportFloorFor('2.4.1-beta.2')).toBe('2.3')
  })

  it('starts a new window at a major release', () => {
    expect(supportFloorFor('1.0.0')).toBe('1.0')
  })

  it('falls back to the widest floor for a version it cannot read', () => {
    expect(supportFloorFor('dev')).toBe('0.0')
    expect(supportFloorFor('0.0.0-dev')).toBe('0.0')
    expect(supportFloorFor('0.6garbage')).toBe('0.0')
    expect(supportFloorFor('0.6.1.2')).toBe('0.0')
  })

  it('reads a version with a build suffix', () => {
    expect(supportFloorFor('v0.6.1+build.7')).toBe('0.5')
  })
})

describe('engineSupportsClient', () => {
  it('serves clients of the current and the previous minor', () => {
    expect(engineSupportsClient(caps('0.6.2'), '0.6.0')).toBe(true)
    expect(engineSupportsClient(caps('0.6.2'), '0.5.9')).toBe(true)
  })

  it('does not serve a client two minors behind', () => {
    expect(engineSupportsClient(caps('0.6.2'), '0.4.1')).toBe(false)
  })

  it('leaves a client newer than the engine to the feature flags', () => {
    expect(engineSupportsClient(caps('0.6.2'), '0.7.0')).toBe(false)
  })

  it('refuses a version it cannot read', () => {
    expect(engineSupportsClient(caps('0.6.2'), 'latest')).toBe(false)
    expect(engineSupportsClient(caps('0.6.2'), '0.6garbage')).toBe(false)
  })
})

describe('engineHasFeature', () => {
  it('is true only for a flag reported on', () => {
    const c = caps('0.6.0', { 'chat.rooms': true, 'chat.steering': false })
    expect(engineHasFeature(c, 'chat.rooms')).toBe(true)
    expect(engineHasFeature(c, 'chat.steering')).toBe(false)
    expect(engineHasFeature(c, 'runtime.codex')).toBe(false)
    expect(engineHasFeature(null, 'chat.rooms')).toBe(false)
  })
})

describe('engineCapabilitiesSchema', () => {
  it('keeps flags it does not know, so a newer engine reaches an older client', () => {
    const parsed = engineCapabilitiesSchema.parse({
      ...caps('0.7.0'),
      features: { 'some.future-flag': true },
      somethingNew: 1,
    })
    expect(parsed.features['some.future-flag']).toBe(true)
    expect(parsed).not.toHaveProperty('somethingNew')
  })

  it('rejects a floor that is not major.minor', () => {
    expect(
      engineCapabilitiesSchema.safeParse({ ...caps('0.6.0'), supportFloor: '0.5.0' }).success,
    ).toBe(false)
  })
})

describe('fetchEngineCapabilities', () => {
  function stubFetch(impl: (url: string) => Promise<Response>) {
    const fn = vi.fn(impl)
    globalThis.fetch = fn as unknown as typeof fetch
    return fn
  }

  it('reads the route against the configured base', async () => {
    const fetchFn = stubFetch(
      async () => ({ ok: true, json: async () => caps('0.6.0') }) as Response,
    )
    setApiBase('https://engine.example.com')
    expect(await fetchEngineCapabilities()).toEqual(caps('0.6.0'))
    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://engine.example.com/api/system/capabilities')
  })

  it('is null for an engine older than the route', async () => {
    stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response)
    expect(await fetchEngineCapabilities()).toBeNull()
  })

  it('is null when an older built engine answers with the dashboard page', async () => {
    stubFetch(
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        }) as unknown as Response,
    )
    expect(await fetchEngineCapabilities()).toBeNull()
  })

  it('is null for a body that is not a capabilities answer', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ current: '0.5.0' }) }) as Response)
    expect(await fetchEngineCapabilities()).toBeNull()
  })

  it('is null when the request fails', async () => {
    stubFetch(async () => {
      throw new Error('offline')
    })
    expect(await fetchEngineCapabilities()).toBeNull()
  })
})
