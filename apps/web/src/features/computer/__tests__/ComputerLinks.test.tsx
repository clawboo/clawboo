// Links to an agent's screen when an administrator turned them off: the
// buttons say so instead of failing.

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const status = vi.hoisted(() => ({ body: {} as Record<string, unknown> }))

vi.mock('@clawboo/control-client', () => ({
  apiUrl: (p: string) => p,
  apiFetch: async () => new Response(JSON.stringify({ ok: true, ...status.body }), { status: 200 }),
}))

const { ComputerLinks } = await import('../ComputerLinks')

beforeEach(() => {
  status.body = {}
})

describe('ComputerLinks', () => {
  it('turns both buttons off, with the reason, when links are off', async () => {
    const reason =
      "Links to agents' screens are turned off by your administrator (CLAWBOO_COMPUTER_LINKS=off)."
    status.body = {
      links: [],
      viewLinks: { allowed: false, reason },
      controlLinks: { allowed: false, reason },
    }
    render(<ComputerLinks agentId="a1" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'View link' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Control link' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'View link' })).toHaveAttribute('title', reason)
    expect(screen.getByTestId('computer-links-off')).toHaveTextContent(reason)
  })

  it('keeps view links when only control links are off', async () => {
    status.body = {
      links: [],
      viewLinks: { allowed: true, reason: null },
      controlLinks: {
        allowed: false,
        reason: 'Control links are turned off by your administrator.',
      },
    }
    render(<ComputerLinks agentId="a1" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Control link' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'View link' })).toBeEnabled()
    expect(screen.queryByTestId('computer-links-off')).toBeNull()
  })
})
