// ChooseRuntimeStep — the "How do you want your agents to run?" pick step.
// RTL pattern (msw onUnhandledRequest:'error' + jest-dom + userEvent). The pick
// cards are selection-only, so the step makes ZERO /api/* calls; clicking a card
// fires onPick with the runtime id (the wizard maps that → the next step).

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChooseRuntimeStep } from '../steps/ChooseRuntimeStep'

afterEach(() => cleanup())

describe('ChooseRuntimeStep', () => {
  it('renders Native as the primary (Recommended) card and the others as secondary', () => {
    render(<ChooseRuntimeStep onPick={vi.fn()} />)
    const native = screen.getByTestId('runtime-pick-clawboo-native')
    expect(native).toHaveAttribute('data-variant', 'wizard-primary')
    expect(screen.getByText('Recommended')).toBeInTheDocument()

    // OpenClaw + the three coding agents are all present + secondary.
    expect(screen.getByTestId('runtime-pick-openclaw')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-pick-claude-code')).toHaveAttribute(
      'data-variant',
      'wizard-secondary',
    )
    expect(screen.getByTestId('runtime-pick-hermes')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-pick-codex')).toBeInTheDocument()
  })

  it('picking Native fires onPick("clawboo-native")', async () => {
    const onPick = vi.fn()
    render(<ChooseRuntimeStep onPick={onPick} />)
    await userEvent.click(screen.getByTestId('runtime-pick-clawboo-native'))
    expect(onPick).toHaveBeenCalledWith('clawboo-native')
  })

  it('picking OpenClaw fires onPick("openclaw")', async () => {
    const onPick = vi.fn()
    render(<ChooseRuntimeStep onPick={onPick} />)
    await userEvent.click(screen.getByTestId('runtime-pick-openclaw'))
    expect(onPick).toHaveBeenCalledWith('openclaw')
  })

  it('picking Claude Code fires onPick("claude-code")', async () => {
    const onPick = vi.fn()
    render(<ChooseRuntimeStep onPick={onPick} />)
    await userEvent.click(screen.getByTestId('runtime-pick-claude-code'))
    expect(onPick).toHaveBeenCalledWith('claude-code')
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<ChooseRuntimeStep onPick={vi.fn()} />)
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
