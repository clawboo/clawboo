// MemberModelSelect — the two-layer provider→model picker. Asserts: the trigger
// shows the transparent default (never "Recommended"); the left column lists ONLY
// the passed (connected-filtered) providers; hovering/clicking a provider reveals
// its models; picking one calls onChange + closes; a default id not in the catalog
// falls back to its readable tail.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemberModelSelect, type ModelPickerGroup } from '../MemberModelSelect'

afterEach(() => cleanup())

const GROUPS: ModelPickerGroup[] = [
  {
    provider: 'Anthropic',
    models: [
      { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    provider: 'OpenRouter',
    models: [{ id: 'openrouter/x/y', label: 'Some OR Model' }],
  },
]

describe('MemberModelSelect', () => {
  it('trigger shows the transparent default (never "Recommended")', () => {
    render(
      <MemberModelSelect
        value=""
        onChange={vi.fn()}
        groups={GROUPS}
        defaultModelId="anthropic/claude-sonnet-4-5"
        data-testid="pick"
      />,
    )
    expect(screen.getByTestId('pick')).toHaveTextContent(/Default · Claude Sonnet 4\.5/i)
    expect(screen.getByTestId('pick')).not.toHaveTextContent(/Recommended/i)
  })

  it('an unknown default id falls back to its readable tail', () => {
    render(
      <MemberModelSelect
        value=""
        onChange={vi.fn()}
        groups={GROUPS}
        // Not in the catalog (dash vs dot mismatch) → show the tail, not bare "Default".
        defaultModelId="openrouter/anthropic/claude-sonnet-4.5"
        data-testid="pick"
      />,
    )
    expect(screen.getByTestId('pick')).toHaveTextContent(/Default · claude-sonnet-4\.5/i)
  })

  it('lists ONLY the passed providers; a provider reveals its models; picking calls onChange + closes', async () => {
    const onChange = vi.fn()
    render(<MemberModelSelect value="" onChange={onChange} groups={GROUPS} data-testid="pick" />)
    await userEvent.click(screen.getByTestId('pick'))
    // Both connected providers, nothing else.
    expect(screen.getByTestId('model-provider-anthropic')).toBeInTheDocument()
    expect(screen.getByTestId('model-provider-openrouter')).toBeInTheDocument()
    expect(screen.queryByTestId('model-provider-openai')).toBeNull()

    // Seeded on the first group → Anthropic's models are shown; pick one.
    await userEvent.click(screen.getByRole('option', { name: /Claude Haiku 4\.5/i }))
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-haiku-4-5')
    // Menu closed on select.
    expect(screen.queryByTestId('model-provider-anthropic')).toBeNull()
  })

  it('clicking a different provider switches the model column', async () => {
    render(<MemberModelSelect value="" onChange={vi.fn()} groups={GROUPS} data-testid="pick" />)
    await userEvent.click(screen.getByTestId('pick'))
    // Anthropic seeded first.
    expect(screen.getByRole('option', { name: /Claude Sonnet 4\.5/i })).toBeInTheDocument()
    // Switch to OpenRouter → its model appears, Anthropic's is gone.
    await userEvent.click(screen.getByTestId('model-provider-openrouter'))
    expect(screen.getByRole('option', { name: /Some OR Model/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Claude Sonnet 4\.5/i })).toBeNull()
  })

  it('pre-selects the provider column matching the current model — a Claude routed via OpenRouter opens on OpenRouter, NOT the first (Codex) column', async () => {
    const CODEX_FIRST: ModelPickerGroup[] = [
      { provider: 'OpenAI Codex', models: [{ id: 'openai-codex/gpt-5.5', label: 'GPT-5.5' }] },
      {
        provider: 'OpenRouter',
        models: [{ id: 'openrouter/anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' }],
      },
    ]
    render(
      <MemberModelSelect
        value=""
        onChange={vi.fn()}
        groups={CODEX_FIRST}
        // The Gateway default is a Claude ROUTED THROUGH OpenRouter (routing prefix
        // `openrouter/…`, dash-vs-dot mismatch so no exact catalog hit).
        defaultModelId="openrouter/anthropic/claude-sonnet-4-5"
        data-testid="pick"
      />,
    )
    await userEvent.click(screen.getByTestId('pick'))
    // The RIGHT column shows OpenRouter's models (inferred from the id prefix), not
    // Codex's — even though Codex is the first group.
    expect(screen.getByRole('option', { name: /Claude Sonnet 4\.5/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /GPT-5\.5/i })).toBeNull()
  })

  it('an explicit pick shows the model label in the trigger (no "Default" prefix)', () => {
    render(
      <MemberModelSelect
        value="anthropic/claude-haiku-4-5"
        onChange={vi.fn()}
        groups={GROUPS}
        defaultModelId="anthropic/claude-sonnet-4-5"
        data-testid="pick"
      />,
    )
    expect(screen.getByTestId('pick')).toHaveTextContent(/Claude Haiku 4\.5/i)
    expect(screen.getByTestId('pick')).not.toHaveTextContent(/Default/i)
  })
})
