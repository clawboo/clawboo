import { describe, it, expect } from 'vitest'

import { formatProviderName } from '../modelCatalog'

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
