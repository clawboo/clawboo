// runtimeCatalog — getKeyUrl maps a provider slug to its "get a key" console
// URL (the affordance shown next to the API-key input), and the api-key
// runtimes carry a keyUrl while the oauth runtime (Codex) does not.

import { describe, expect, it } from 'vitest'

import { PROVIDER_KEY_URLS, RUNTIME_CATALOG, getKeyUrl } from '../runtimeCatalog'

describe('getKeyUrl', () => {
  it('returns the console URL for each known provider', () => {
    expect(getKeyUrl('anthropic')).toBe(PROVIDER_KEY_URLS.anthropic)
    expect(getKeyUrl('openai')).toContain('platform.openai.com')
    expect(getKeyUrl('openrouter')).toContain('openrouter.ai')
  })

  it('returns undefined for a keyless / unknown provider', () => {
    expect(getKeyUrl('ollama')).toBeUndefined()
    expect(getKeyUrl('nope')).toBeUndefined()
  })
})

describe('RUNTIME_CATALOG keyUrl', () => {
  it('api-key runtimes carry a keyUrl; the oauth runtime does not', () => {
    expect(RUNTIME_CATALOG['claude-code'].keyUrl).toBeTruthy()
    expect(RUNTIME_CATALOG.hermes.keyUrl).toBeTruthy()
    // Codex signs in via `codex login` — there is no API key to mint.
    expect(RUNTIME_CATALOG.codex.authKind).toBe('oauth')
    expect(RUNTIME_CATALOG.codex.keyUrl).toBeUndefined()
  })
})
