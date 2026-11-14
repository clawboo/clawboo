// The Browser card shows the agent's screen live, and says why when it cannot.

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const grant = vi.hoisted(() => ({ value: 'granted' as 'granted' | 'missing' | 'unknown' }))

vi.mock('../useBrowserGrant', () => ({ useBrowserGrant: () => grant.value }))
vi.mock('../useAgentScreenshot', () => ({
  useAgentScreenshot: () => ({ meta: null, checked: true, src: null }),
}))
vi.mock('@/features/computer/ComputerLinks', () => ({ ComputerLinks: () => null }))
vi.mock('@/features/computer/ComputerScreen', () => ({
  ComputerScreen: ({ target }: { target: { kind: string; agentId?: string } }) => (
    <div data-testid="live-screen">{`${target.kind}:${target.agentId ?? ''}`}</div>
  ),
}))

const { BrowserPanel } = await import('../BrowserPanel')

describe('BrowserPanel', () => {
  it('shows the agent screen live, signed in as the dashboard', () => {
    grant.value = 'granted'
    render(<BrowserPanel agentId="a1" />)
    expect(screen.getByTestId('live-screen').textContent).toBe('dashboard:a1')
  })

  it('names the missing grant instead of an empty view', () => {
    grant.value = 'missing'
    render(<BrowserPanel agentId="a1" />)
    expect(screen.queryByTestId('live-screen')).toBeNull()
    expect(screen.getByText(/No browser connector has been granted/)).toBeTruthy()
  })
})
