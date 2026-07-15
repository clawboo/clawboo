import { describe, expect, it } from 'vitest'

import {
  HERMES_MODEL_GROUPS,
  HERMES_OPENROUTER_GROUP_NAME,
  hermesModelExec,
} from '../hermesModelCatalog'

describe('hermesModelCatalog', () => {
  it('maps every picked model id to the openrouter provider (Hermes routes all models via OpenRouter)', () => {
    expect(hermesModelExec('openai/gpt-4o-mini')).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
    })
    expect(hermesModelExec('anthropic/claude-3.5-sonnet')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
    })
    // A live / unlisted OpenRouter id still routes via openrouter.
    expect(hermesModelExec('mistralai/mixtral-8x7b')).toEqual({
      provider: 'openrouter',
      model: 'mistralai/mixtral-8x7b',
    })
  })

  it('returns null for an empty id (caller keeps the key-derived default)', () => {
    expect(hermesModelExec('')).toBeNull()
  })

  it('exposes a single OpenRouter fallback group of vendor/model slugs that all resolve', () => {
    expect(HERMES_MODEL_GROUPS).toHaveLength(1)
    expect(HERMES_MODEL_GROUPS[0]!.provider).toBe(HERMES_OPENROUTER_GROUP_NAME)
    expect(HERMES_MODEL_GROUPS[0]!.models.length).toBeGreaterThan(0)
    for (const m of HERMES_MODEL_GROUPS[0]!.models) {
      expect(m.id).toContain('/') // OpenRouter vendor/model slug
      expect(hermesModelExec(m.id)).toEqual({ provider: 'openrouter', model: m.id })
    }
  })
})
