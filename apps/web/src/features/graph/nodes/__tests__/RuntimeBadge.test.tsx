import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeBadge } from '../RuntimeBadge'

afterEach(() => cleanup())

describe('RuntimeBadge', () => {
  it('labels the Clawboo Native runtime as an accessible image and renders a glyph', () => {
    render(<RuntimeBadge runtime="clawboo-native" />)
    // role="img" + aria-label is the reliable accessible-name pattern.
    const el = screen.getByRole('img', { name: 'Runtime: Clawboo Native' })
    expect(el).toBeInTheDocument()
    // The chip is decorative — it must never intercept the Boo's pointer events.
    expect(el).toHaveStyle({ pointerEvents: 'none' })
    expect(el.querySelector('svg')).toBeInTheDocument()
  })

  it('falls back to the OpenClaw mark for null / openclaw / unknown runtimes', () => {
    const { rerender } = render(<RuntimeBadge runtime={null} />)
    expect(screen.getByLabelText('Runtime: OpenClaw')).toBeInTheDocument()
    rerender(<RuntimeBadge runtime="openclaw" />)
    expect(screen.getByLabelText('Runtime: OpenClaw')).toBeInTheDocument()
  })

  it('handles the mono brands (codex / hermes) without crashing', () => {
    render(<RuntimeBadge runtime="hermes" size={16} />)
    expect(screen.getByLabelText('Runtime: Hermes')).toBeInTheDocument()
  })
})
