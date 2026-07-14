import { describe, expect, it } from 'vitest'

import { PROVIDER_CATALOG } from '../providerCatalog'

describe('providerCatalog', () => {
  it('has 14 key-based providers with unique ids + valid env vars', () => {
    expect(PROVIDER_CATALOG).toHaveLength(14)
    const ids = PROVIDER_CATALOG.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PROVIDER_CATALOG) {
      expect(p.envVar).toMatch(/^[A-Z0-9_]+$/)
      expect(p.name.length).toBeGreaterThan(0)
      expect(['primary', 'more']).toContain(p.tier)
    }
  })

  it('env-var slots match the server mapping for the shared providers', () => {
    const byId = Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, p.envVar]))
    expect(byId['anthropic']).toBe('ANTHROPIC_API_KEY')
    expect(byId['openrouter']).toBe('OPENROUTER_API_KEY')
    expect(byId['google']).toBe('GEMINI_API_KEY')
    expect(byId['huggingface']).toBe('HF_TOKEN')
  })
})
