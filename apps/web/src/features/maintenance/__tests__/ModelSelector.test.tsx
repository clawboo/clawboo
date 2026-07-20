// ModelSelector — the OpenClaw default-model picker. Regression for the greyed
// "No key" on a keyless-but-connected provider: the server reports the ChatGPT
// subscription by its ID ('openai-codex', hyphen) while the catalog group is the
// display name ('OpenAI Codex', space). A bare .toLowerCase() mismatched the two
// and greyed a connected subscription as "No key"; the fix compares via
// providerSlug. The catalog hook is mocked so this is pure (no network/cache).

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelSelector } from '../ModelSelector'

vi.mock('@/lib/useModelCatalog', () => ({
  useModelCatalog: () => ({
    groups: [
      { provider: 'OpenAI Codex', models: [{ id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' }] },
      {
        provider: 'Anthropic',
        models: [{ id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
      },
    ],
    // Only the subscription is connected — reported by its hyphenated ID.
    configuredProviders: new Set(['openai-codex']),
  }),
}))

afterEach(() => cleanup())

describe('ModelSelector', () => {
  it('a subscription-configured provider (id "openai-codex" ↔ name "OpenAI Codex") is NOT greyed "No key"', async () => {
    render(<ModelSelector currentModel={null} onModelChange={vi.fn()} />)
    // Open the dropdown (trigger shows "Not set" for a null model).
    await userEvent.click(screen.getByText('Not set'))

    // OpenAI Codex is connected via the subscription → no amber "No key" badge.
    const codexRow = screen.getByText('OpenAI Codex').closest('button')
    expect(codexRow).not.toBeNull()
    expect(codexRow).not.toHaveTextContent(/No key/i)

    // Anthropic has no key here → it DOES carry the badge (proves the contrast is real).
    const anthropicRow = screen.getByText('Anthropic').closest('button')
    expect(anthropicRow).toHaveTextContent(/No key/i)
  })
})
