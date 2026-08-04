import { describe, it, expect } from 'vitest'

import {
  MODEL_GROUPS,
  findModelLabel,
  findProviderForModel,
  formatProviderName,
  providerSlug,
} from '../catalog'

describe('formatProviderName', () => {
  it('maps live CLI lowercase provider ids back to the catalog casing', () => {
    // The OpenClaw CLI emits bare-lowercase ids; the catalog is the source of truth.
    expect(formatProviderName('huggingface')).toBe('Hugging Face')
    expect(formatProviderName('minimax')).toBe('MiniMax')
    expect(formatProviderName('openrouter')).toBe('OpenRouter')
    expect(formatProviderName('openai')).toBe('OpenAI')
    expect(formatProviderName('nvidia')).toBe('NVIDIA')
    expect(formatProviderName('xai')).toBe('xAI')
  })

  it('is idempotent on already-canonical names', () => {
    expect(formatProviderName('Hugging Face')).toBe('Hugging Face')
    expect(formatProviderName('OpenRouter')).toBe('OpenRouter')
    expect(formatProviderName('Anthropic')).toBe('Anthropic')
  })

  it('is space/case/punctuation-insensitive when matching', () => {
    expect(formatProviderName('HUGGING_FACE')).toBe('Hugging Face')
    expect(formatProviderName('Hugging-Face')).toBe('Hugging Face')
    expect(formatProviderName('z.ai')).toBe('Z.AI')
  })

  it('title-cases unknown providers, preserving all-caps tokens', () => {
    expect(formatProviderName('acme')).toBe('Acme')
    expect(formatProviderName('some_new-provider')).toBe('Some New Provider')
    expect(formatProviderName('ACME AI')).toBe('ACME AI')
  })
})

describe('providerSlug', () => {
  it('collapses spaces, case, and punctuation to one comparison key', () => {
    // The whole point: display names and live CLI ids must land on the same key.
    expect(providerSlug('Hugging Face')).toBe(providerSlug('huggingface'))
    expect(providerSlug('OpenAI Codex')).toBe(providerSlug('openai-codex'))
    expect(providerSlug('Z.AI')).toBe(providerSlug('zai'))
    expect(providerSlug('Synthetic (Free)')).toBe('syntheticfree')
  })

  it('keeps distinct providers distinct', () => {
    expect(providerSlug('OpenAI')).not.toBe(providerSlug('OpenAI Codex'))
    expect(providerSlug('OpenAI')).not.toBe(providerSlug('OpenRouter'))
  })
})

describe('findModelLabel', () => {
  it('returns the display label for a known model id', () => {
    expect(findModelLabel('anthropic/claude-opus-4-6')).toBe('Claude Opus 4.6')
    expect(findModelLabel('ollama/llama3.3')).toBe('Llama 3.3')
  })

  it('returns null for an unknown model id', () => {
    expect(findModelLabel('acme/does-not-exist')).toBeNull()
  })
})

describe('findProviderForModel', () => {
  it('returns the owning provider group for a known model id', () => {
    expect(findProviderForModel('anthropic/claude-opus-4-6')).toBe('Anthropic')
    expect(findProviderForModel('openai-codex/gpt-5.5')).toBe('OpenAI Codex')
  })

  it('falls back to the id prefix for an unknown model', () => {
    expect(findProviderForModel('acme/some-model')).toBe('acme')
  })

  it('returns null when an unknown id has no provider prefix', () => {
    expect(findProviderForModel('bare-model-id')).toBeNull()
  })
})

describe('MODEL_GROUPS invariants', () => {
  it('has no empty provider groups', () => {
    for (const group of MODEL_GROUPS) {
      expect(group.provider.length, 'empty provider name').toBeGreaterThan(0)
      expect(group.models.length, `${group.provider} has no models`).toBeGreaterThan(0)
    }
  })

  it('has globally unique model ids', () => {
    const ids = MODEL_GROUPS.flatMap((g) => g.models.map((m) => m.id))
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(duplicates).toEqual([])
  })

  it('has provider slugs that are unique across groups', () => {
    // Two groups sharing a slug would silently collapse in the canonical-name
    // map the server builds from this catalog in `/api/system/models`.
    const slugs = MODEL_GROUPS.map((g) => providerSlug(g.provider))
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('resolves every catalog model through both lookup helpers', () => {
    for (const group of MODEL_GROUPS) {
      for (const model of group.models) {
        expect(findModelLabel(model.id)).toBe(model.label)
        expect(findProviderForModel(model.id)).toBe(group.provider)
      }
    }
  })
})
