// The native model catalog — native-format model ids (distinct from the OpenClaw
// MODEL_GROUPS routing ids), per-provider scoping, and the model→exec reverse map.

import { describe, expect, it } from 'vitest'

import {
  findNativeModelLabel,
  NATIVE_MODEL_GROUPS,
  nativeLeaderModelFor,
  nativeModelExec,
  nativeModelGroupsFor,
  nativeProviderIdForGroup,
  envVarForNativeProvider,
  nativeExecForPick,
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

  it('nativeExecForPick keeps a live-listed pick, which an id lookup would drop', () => {
    // The bug this exists for: a picker fed the provider's LIVE model list offers
    // ids the curated catalog has never seen. Deriving the provider from the id
    // returns null, the caller treats that as "no pick", and the user silently
    // gets the provider's default model instead of the one they clicked.
    expect(nativeModelExec('claude-opus-4-1-20250805')).toBeNull()
    expect(nativeExecForPick('claude-opus-4-1-20250805', 'Anthropic')).toEqual({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-opus-4-1-20250805',
      envVar: 'ANTHROPIC_API_KEY',
    })
    // No group (a pick that arrived without one) falls back to the id lookup.
    expect(nativeExecForPick('claude-sonnet-5', undefined)).toEqual({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-sonnet-5',
      envVar: 'ANTHROPIC_API_KEY',
    })
    // A group the native catalog does not own also falls back rather than guessing.
    expect(nativeExecForPick('mystery-model', 'OpenAI Codex')).toBeNull()
    // No model at all means no override: the agent keeps its modelTier resolve.
    expect(nativeExecForPick(undefined, 'Anthropic')).toBeNull()
    expect(nativeExecForPick('', 'Anthropic')).toBeNull()
  })

  it('findNativeModelLabel returns the label or null for a custom id', () => {
    expect(findNativeModelLabel('gpt-4o')).toBe('GPT-4o')
    expect(findNativeModelLabel('custom/thing')).toBeNull()
  })

  it("envVarForNativeProvider names each provider's vault slot", () => {
    expect(envVarForNativeProvider('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(envVarForNativeProvider('openrouter')).toBe('OPENROUTER_API_KEY')
    // Ollama is keyless; its placeholder is also the unknown-provider fallback,
    // matching the server's own `envVarForProvider(p) ?? 'OLLAMA_BASE_URL'`.
    expect(envVarForNativeProvider('ollama')).toBe('OLLAMA_BASE_URL')
    expect(envVarForNativeProvider('not-a-provider')).toBe('OLLAMA_BASE_URL')
  })

  it('nativeProviderIdForGroup maps every group label back to its provider id', () => {
    // The picker sends the provider of the GROUP the user clicked, because the
    // Anthropic / OpenAI / OpenRouter groups swap in LIVE model lists whose ids
    // are the provider's verbatim ones. Resolving the provider from the id would
    // return null for nearly all of them, leaving the agent on its old provider
    // with another provider's model: the exact silent break this catalog feeds.
    for (const group of NATIVE_MODEL_GROUPS) {
      expect(nativeProviderIdForGroup(group.provider)).toBeTruthy()
    }
    expect(nativeProviderIdForGroup('Anthropic')).toBe('anthropic')
    expect(nativeProviderIdForGroup('OpenRouter')).toBe('openrouter')
    expect(nativeProviderIdForGroup('Ollama')).toBe('ollama')
    // Live-listed ids are unknown to the static catalog, but the GROUP still resolves.
    expect(nativeModelExec('claude-opus-4-1-20250805')).toBeNull()
    expect(nativeProviderIdForGroup('Anthropic')).toBe('anthropic')
    // A non-native group (Hermes) has no native provider.
    expect(nativeProviderIdForGroup('OpenAI Codex')).toBeNull()
  })
})
