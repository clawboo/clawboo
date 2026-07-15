import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentRuntimeBadge, runtimeLabel } from '../RuntimeBrand'

afterEach(() => cleanup())

describe('runtimeLabel', () => {
  it('names each runtime; null / openclaw / unknown fall back to OpenClaw', () => {
    expect(runtimeLabel('clawboo-native')).toBe('Clawboo Native')
    expect(runtimeLabel('claude-code')).toBe('Claude Code')
    expect(runtimeLabel('codex')).toBe('Codex')
    expect(runtimeLabel('hermes')).toBe('Hermes')
    expect(runtimeLabel('openclaw')).toBe('OpenClaw')
    expect(runtimeLabel(null)).toBe('OpenClaw')
    expect(runtimeLabel(undefined)).toBe('OpenClaw')
    expect(runtimeLabel('something-else')).toBe('OpenClaw')
  })
})

describe('AgentRuntimeBadge', () => {
  it('labels the badge with the runtime name (icon + tooltip)', () => {
    render(<AgentRuntimeBadge runtime="hermes" />)
    const badge = screen.getByLabelText('Runtime: Hermes')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute('title', 'Runtime: Hermes')
    expect(badge.querySelector('svg')).toBeInTheDocument()
  })

  it('falls back to the OpenClaw mark for a null runtime (OpenClaw is not a RuntimeId)', () => {
    render(<AgentRuntimeBadge runtime={null} />)
    expect(screen.getByLabelText('Runtime: OpenClaw')).toBeInTheDocument()
  })
})
