// RuntimeSubscriptionSection — the add-anytime ChatGPT-subscription section for
// a connected Hermes / OpenClaw. Three detection-gated states. RTL + jest-dom.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeSubscriptionSection } from '../RuntimeSubscriptionSection'

afterEach(() => cleanup())

describe('RuntimeSubscriptionSection', () => {
  it('addable (Codex connected, sub absent) → the sign-in flow is offered', () => {
    render(
      <RuntimeSubscriptionSection
        tool="hermes"
        name="Hermes"
        loginCommand="hermes auth add openai-codex"
        connected={false}
        codexReady
        onChanged={vi.fn()}
      />,
    )
    expect(screen.getByTestId('runtime-hermes-subscription-add')).toBeInTheDocument()
    // The ChatGptSignIn idle trigger is present (no confirmation, no hint).
    expect(screen.getByTestId('chatgpt-signin-hermes-start')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-hermes-subscription-connected')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-hermes-subscription-needs-codex')).not.toBeInTheDocument()
  })

  it('connected (sub already present) → a calm confirmation, no sign-in action', () => {
    render(
      <RuntimeSubscriptionSection
        tool="openclaw"
        name="OpenClaw"
        loginCommand="openclaw models auth login --provider openai-codex"
        connected
        codexReady
        onChanged={vi.fn()}
      />,
    )
    expect(screen.getByTestId('runtime-openclaw-subscription-connected')).toBeInTheDocument()
    expect(screen.queryByTestId('chatgpt-signin-openclaw-start')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-openclaw-subscription-add')).not.toBeInTheDocument()
  })

  it('Codex not connected → a "connect Codex first" hint, no sign-in button', () => {
    render(
      <RuntimeSubscriptionSection
        tool="hermes"
        name="Hermes"
        loginCommand="hermes auth add openai-codex"
        connected={false}
        codexReady={false}
        onChanged={vi.fn()}
      />,
    )
    const hint = screen.getByTestId('runtime-hermes-subscription-needs-codex')
    expect(hint).toHaveTextContent(/Connect Codex first/i)
    expect(screen.queryByTestId('chatgpt-signin-hermes-start')).not.toBeInTheDocument()
  })
})
