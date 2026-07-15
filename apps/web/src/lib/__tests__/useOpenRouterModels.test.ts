// Pure helpers behind the OpenClaw OpenRouter unification — mapping the live
// `vendor/model` ids into OpenClaw `openrouter/…` routing ids, and merging that
// group into an existing catalog.

import { describe, expect, it } from 'vitest'

import { openClawOpenRouterGroup, mergeOpenRouterGroup } from '../useOpenRouterModels'
import type { ModelGroup } from '../modelCatalog'

describe('openClawOpenRouterGroup', () => {
  it('prefixes each live id with `openrouter/` and keeps the label', () => {
    const g = openClawOpenRouterGroup([
      { id: 'anthropic/claude-sonnet-4.5', label: 'Anthropic: Claude Sonnet 4.5' },
      { id: 'openai/gpt-4o', label: 'OpenAI: GPT-4o' },
    ])
    expect(g?.provider).toBe('OpenRouter')
    expect(g?.models.map((m) => m.id)).toEqual([
      'openrouter/anthropic/claude-sonnet-4.5',
      'openrouter/openai/gpt-4o',
    ])
    expect(g?.models[0]?.label).toBe('Anthropic: Claude Sonnet 4.5')
  })

  it('returns null for an empty live list (caller keeps its own base list)', () => {
    expect(openClawOpenRouterGroup([])).toBeNull()
  })
})

describe('mergeOpenRouterGroup', () => {
  const orGroup: ModelGroup = {
    provider: 'OpenRouter',
    models: [{ id: 'openrouter/new', label: 'New' }],
  }

  it('replaces an existing OpenRouter group (case-insensitive), preserving order + others', () => {
    const base: ModelGroup[] = [
      { provider: 'Anthropic', models: [{ id: 'anthropic/x', label: 'X' }] },
      { provider: 'openrouter', models: [{ id: 'openrouter/old', label: 'Old' }] },
    ]
    const merged = mergeOpenRouterGroup(base, orGroup)
    expect(merged).toHaveLength(2)
    expect(merged[0]?.provider).toBe('Anthropic')
    expect(merged[1]).toBe(orGroup)
  })

  it('appends when there is no OpenRouter group', () => {
    const base: ModelGroup[] = [{ provider: 'Anthropic', models: [] }]
    const merged = mergeOpenRouterGroup(base, orGroup)
    expect(merged).toHaveLength(2)
    expect(merged[1]).toBe(orGroup)
  })

  it('returns the base unchanged when there is no live group (null)', () => {
    const base: ModelGroup[] = [{ provider: 'OpenRouter', models: [{ id: 'openrouter/old', label: 'Old' }] }]
    expect(mergeOpenRouterGroup(base, null)).toBe(base)
  })
})
