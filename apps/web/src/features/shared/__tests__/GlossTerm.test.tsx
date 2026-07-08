// GlossTerm — the jargon tooltip. Asserts the accessible wiring (a focusable
// button described by a role="tooltip" node via aria-describedby) + no a11y
// violations. The tooltip node is always in the DOM (visually hidden at rest)
// so the description resolves even before hover.

import { cleanup, render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { afterEach, describe, expect, it } from 'vitest'

import { GlossTerm } from '../GlossTerm'

afterEach(() => cleanup())

describe('GlossTerm', () => {
  it('wires the trigger to a role="tooltip" definition via aria-describedby', () => {
    render(<GlossTerm term="Gateway" definition="The local OpenClaw server." />)
    const trigger = screen.getByRole('button', { name: 'Gateway' })
    const describedby = trigger.getAttribute('aria-describedby')
    expect(describedby).toBeTruthy()
    const tip = document.getElementById(describedby as string)
    expect(tip).not.toBeNull()
    expect(tip).toHaveAttribute('role', 'tooltip')
    expect(tip).toHaveTextContent('The local OpenClaw server.')
  })

  it('renders custom child text over the raw term', () => {
    render(
      <GlossTerm term="Native" definition="Built-in runtime.">
        the native runtime
      </GlossTerm>,
    )
    expect(screen.getByRole('button', { name: 'the native runtime' })).toBeInTheDocument()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(
      <GlossTerm term="runtime" definition="An engine that runs agents." />,
    )
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
