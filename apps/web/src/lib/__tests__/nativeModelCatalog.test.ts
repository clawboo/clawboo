// The native model catalog — native-format model ids (distinct from the OpenClaw
// MODEL_GROUPS routing ids), per-provider scoping, and the model→exec reverse map.

import { describe, expect, it } from 'vitest'

import {
  findNativeModelLabel,
  NATIVE_MODEL_GROUPS,
  nativeLeaderModelFor,
  nativeModelExec,
  nativeModelGroupsFor,
} from '../nativeModelCatalog'

describe('nativeModelCatalog', () => {
  it('uses provider-NATIVE model ids (not OpenClaw routing ids)', () => {
    const anthropic = NATIVE_MODEL_GROUPS.find((g) => g.provider === 'Anthropic')
    // bare Anthropic id — NOT `anthropic/claude-…`
    expect(anthropic?.models.some((m) => m.id === 'claude-sonnet-5')).toBe(true)
    expect(anthropic?.models.every((m) => !m.id.includes('/'))).toBe(true)
    const openrouter = NATIVE_MODEL_GROUPS.find((g) => g.provider === 'OpenRouter')
    // OpenRouter ids are `vendor/model` — NOT prefixed with `openrouter/`
    expect(openrouter?.models.some((m) => m.id === 'anthropic/claude-haiku-4.5')).toBe(true)
    expect(openrouter?.models.every((m) => !m.id.startsWith('openrouter/'))).toBe(true)
  })

  it('nativeModelGroupsFor scopes to one provider (case-insensitive)', () => {
    const g = nativeModelGroupsFor('openrouter')
    expect(g).toHaveLength(1)
    expect(g[0]?.provider).toBe('OpenRouter')
    // an unknown provider returns all groups
    expect(nativeModelGroupsFor('nope').length).toBe(NATIVE_MODEL_GROUPS.length)
  })

  it('nativeLeaderModelFor returns the strongest (index 0) model per provider', () => {
    expect(nativeLeaderModelFor('anthropic')).toBe('claude-sonnet-5')
    expect(nativeLeaderModelFor('openrouter')).toBe('anthropic/claude-sonnet-4.5')
    expect(nativeLeaderModelFor('ollama')).toBe('llama3.2')
    expect(nativeLeaderModelFor('nope')).toBe('')
  })

  it('nativeModelExec maps a catalog id → {provider, model, envVar}', () => {
    expect(nativeModelExec('claude-sonnet-5')).toEqual({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-sonnet-5',
      envVar: 'ANTHROPIC_API_KEY',
    })
    expect(nativeModelExec('anthropic/claude-haiku-4.5')).toEqual({
      primaryProvider: 'openrouter',
      primaryModel: 'anthropic/claude-haiku-4.5',
      envVar: 'OPENROUTER_API_KEY',
    })
    expect(nativeModelExec('llama3.2')?.envVar).toBe('OLLAMA_BASE_URL')
    // an unknown `vendor/model` id (has a "/") → treated as OpenRouter, so a
    // dynamically-fetched OpenRouter model not in the curated map still routes.
    expect(nativeModelExec('some/unknown-model')).toEqual({
      primaryProvider: 'openrouter',
      primaryModel: 'some/unknown-model',
      envVar: 'OPENROUTER_API_KEY',
    })
    // an unknown BARE id (no "/") → null (caller keeps modelTier auto-resolve)
    expect(nativeModelExec('mystery-model')).toBeNull()
  })

  it('findNativeModelLabel returns the label or null for a custom id', () => {
    expect(findNativeModelLabel('gpt-4o')).toBe('GPT-4o')
    expect(findNativeModelLabel('custom/thing')).toBeNull()
  })
})
