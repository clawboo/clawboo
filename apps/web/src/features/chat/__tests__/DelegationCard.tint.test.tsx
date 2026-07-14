import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'

import { DelegationCard } from '../chatComponents'

afterEach(cleanup)

// DelegationCard renders AgentBooAvatar/BooAvatar, which read theme context.
const renderCard = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

beforeEach(() => {
  useFleetStore.setState({ agents: [], selectedAgentId: null } as never)
  useBooZeroStore.setState({ booZeroAgentId: null })
})

describe('DelegationCard tint fallback', () => {
  it('renders a valid color-mix tint when the target is not in the fleet store', () => {
    // Target name resolves to no agent → tint falls back to the CSS var
    // `var(--mint)`. Alpha must be applied with color-mix (a var-safe operand);
    // the old `${tint}33` hex-suffix concat produced invalid `var(--mint)33`,
    // which the browser dropped — leaving a borderless, untinted card.
    renderCard(<DelegationCard targetName="Ghost Boo" task="investigate the flake" />)

    const card = screen.getByTestId('delegation-card')
    const style = card.getAttribute('style') ?? ''

    // Fallback tint is applied via color-mix over the CSS var (valid CSS)...
    expect(style).toContain('color-mix(in srgb, var(--mint)')
    // ...and never as an invalid hex-suffix concatenation on the var.
    expect(style).not.toMatch(/var\(--mint\)\d/)
  })

  it('applies the resolved tint via color-mix when the target IS in the fleet', () => {
    useFleetStore.setState({
      agents: [{ id: 'a9', name: 'Research Boo', teamId: null }],
    } as never)

    renderCard(<DelegationCard targetName="Research Boo" task="dig in" />)

    const style = screen.getByTestId('delegation-card').getAttribute('style') ?? ''
    // Common path also routes through color-mix (one alpha idiom across the
    // tint-identity card family) — never a bare `#rrggbbaa` hex concat.
    expect(style).toContain('color-mix(in srgb')
    expect(style).not.toMatch(/#[0-9a-fA-F]{8}\b/)
  })
})
