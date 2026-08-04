import { describe, it, expect } from 'vitest'

import {
  MODEL_GROUPS,
  findModelLabel,
  findProviderForModel,
  formatProviderName,
  providerSlug,
  type ModelGroup,
  type ModelOption,
} from '../modelCatalog'

// The catalog itself is tested in @clawboo/model-catalog. What matters HERE is
// that the re-export shim keeps the full public surface intact: ~14 SPA call
// sites import through this path, and narrowing the shim (e.g. swapping the
// `export *` for a hand-listed set) would break them at build time only.
describe('modelCatalog shim', () => {
  it('re-exports every value the SPA call sites use', () => {
    expect(Array.isArray(MODEL_GROUPS)).toBe(true)
    expect(MODEL_GROUPS.length).toBeGreaterThan(0)
    expect(typeof findModelLabel).toBe('function')
    expect(typeof findProviderForModel).toBe('function')
    expect(typeof formatProviderName).toBe('function')
    expect(typeof providerSlug).toBe('function')
  })

  it('re-exports the types the SPA call sites import', () => {
    // Type-only assertion: `pnpm typecheck` fails if either type stops
    // resolving through the shim. The runtime expectation is incidental.
    const option: ModelOption = { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' }
    const group: ModelGroup = { provider: 'Anthropic', models: [option] }
    expect(group.models[0]?.id).toBe(option.id)
  })

  it('resolves through to the real catalog', () => {
    expect(formatProviderName('huggingface')).toBe('Hugging Face')
    expect(findModelLabel('anthropic/claude-opus-4-6')).toBe('Claude Opus 4.6')
  })
})
