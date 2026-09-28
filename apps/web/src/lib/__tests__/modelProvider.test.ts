import { describe, expect, it } from 'vitest'

import { prettifyModelId, resolveModelProvider } from '../modelProvider'

describe('resolveModelProvider', () => {
  it('resolves native provider-native ids by maker', () => {
    expect(resolveModelProvider('claude-sonnet-5', 'clawboo-native').providerId).toBe('anthropic')
    expect(resolveModelProvider('gpt-4o', 'clawboo-native').providerId).toBe('openai')
    expect(resolveModelProvider('gemini-2.0-flash', 'clawboo-native').providerId).toBe('google')
    expect(resolveModelProvider('grok-3', 'clawboo-native').providerId).toBe('xai')
  })

  it('recovers the real vendor from a native OpenRouter vendor/model id', () => {
    // nativeModelExec collapses unrecognized vendor/model to "openrouter" — we
    // recover the actual maker so the icon agrees with the label.
    expect(resolveModelProvider('anthropic/claude-sonnet-4.5', 'clawboo-native').providerId).toBe(
      'anthropic',
    )
  })

  it('resolves OpenClaw routing ids provider/model by the prefix', () => {
    expect(resolveModelProvider('anthropic/claude-haiku-4-5', 'openclaw').providerId).toBe(
      'anthropic',
    )
    expect(resolveModelProvider('openai/gpt-4o', 'openclaw').providerId).toBe('openai')
    expect(resolveModelProvider('google/gemini-2.5-pro', 'openclaw').providerId).toBe('google')
    expect(resolveModelProvider('xai/grok-3', 'openclaw').providerId).toBe('xai')
  })

  it('recovers the vendor from a double-nested OpenClaw OpenRouter id', () => {
    expect(
      resolveModelProvider('openrouter/anthropic/claude-opus-4-6', 'openclaw').providerId,
    ).toBe('anthropic')
    // `x-ai` vendor spelling normalizes to the `xai` ProviderId.
    expect(resolveModelProvider('openrouter/x-ai/grok-3', 'openclaw').providerId).toBe('xai')
  })

  it('resolves Hermes (OpenRouter vendor/model) by maker, falling back to OpenRouter', () => {
    expect(resolveModelProvider('anthropic/claude-sonnet-4.5', 'hermes').providerId).toBe(
      'anthropic',
    )
    // An OpenRouter vendor with no brand of its own → the OpenRouter mark (a real
    // mark), never a blank/generic.
    expect(resolveModelProvider('deepseek/deepseek-r1', 'hermes').providerId).toBe('openrouter')
    expect(resolveModelProvider('meta-llama/llama-3.3-70b-instruct', 'hermes').providerId).toBe(
      'openrouter',
    )
  })

  it('returns Default model with no provider for a null/empty model (codex / claude-code)', () => {
    expect(resolveModelProvider(null, 'codex')).toEqual({
      providerId: null,
      label: 'Default model',
    })
    expect(resolveModelProvider('', 'claude-code')).toEqual({
      providerId: null,
      label: 'Default model',
    })
    expect(resolveModelProvider(undefined, 'claude-code').providerId).toBeNull()
  })

  it('returns null provider (generic glyph) for a genuinely unknown model, keeping a usable label', () => {
    const r = resolveModelProvider('some-custom-model-xyz', 'openclaw')
    expect(r.providerId).toBeNull()
    expect(r.label).toBe('Some Custom Model Xyz')
  })

  it('names an uncatalogued model the way the catalog would, not by its raw id', () => {
    // The model tile used to print the id itself, so an agent on a model clawboo
    // had not catalogued read "minimax-m2.7" beside tiles reading "Claude Sonnet 4.6".
    expect(resolveModelProvider('minimax/minimax-m2.7', 'clawboo-native').label).toBe(
      'MiniMax M2.7',
    )
  })

  it('always returns a non-empty label', () => {
    for (const [m, rt] of [
      ['claude-sonnet-5', 'clawboo-native'],
      ['anthropic/claude-haiku-4-5', 'openclaw'],
      ['deepseek/deepseek-r1', 'hermes'],
      ['x/y/z', 'openclaw'],
    ] as const) {
      expect(resolveModelProvider(m, rt).label.length).toBeGreaterThan(0)
    }
  })
})

describe('prettifyModelId', () => {
  it('joins a version the id spells as separate numbers', () => {
    expect(prettifyModelId('anthropic/claude-sonnet-4-5')).toBe('Claude Sonnet 4.5')
    expect(prettifyModelId('claude-opus-5')).toBe('Claude Opus 5')
    expect(prettifyModelId('meta-llama/llama-3-1-405b')).toBe('Llama 3.1 405B')
    // A snapshot number is not a minor version.
    expect(prettifyModelId('gpt-4-1106-preview')).toBe('GPT 4 1106 Preview')
  })

  it('drops a snapshot date, which names a build rather than a model', () => {
    expect(prettifyModelId('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet')
    expect(prettifyModelId('gpt-4o-2024-08-06')).toBe('GPT 4o')
  })

  it("keeps each maker's own casing", () => {
    expect(prettifyModelId('openai/gpt-4o-mini')).toBe('GPT 4o Mini')
    expect(prettifyModelId('o3-mini')).toBe('o3 Mini')
    expect(prettifyModelId('deepseek/deepseek-r1')).toBe('DeepSeek R1')
    expect(prettifyModelId('meta-llama/llama-3.3-70b-instruct')).toBe('Llama 3.3 70B Instruct')
    expect(prettifyModelId('z-ai/glm-4.5')).toBe('GLM 4.5')
  })

  it('leaves a spelling someone already chose alone', () => {
    expect(prettifyModelId('minimax/MiniMax-M2.5')).toBe('MiniMax M2.5')
  })
})
