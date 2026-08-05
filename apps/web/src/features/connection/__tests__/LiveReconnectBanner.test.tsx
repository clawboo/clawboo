import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LiveReconnectBanner } from '../LiveReconnectBanner'

afterEach(() => cleanup())

describe('LiveReconnectBanner', () => {
  it('states that the socket dropped and is retrying on its own', () => {
    render(<LiveReconnectBanner onConnectManually={vi.fn()} />)

    expect(screen.getByTestId('gateway-live-reconnect-banner')).toBeInTheDocument()
    expect(screen.getByText('Reconnecting to Gateway…')).toBeInTheDocument()
    // Honest copy: the user does not have to do anything.
    expect(
      screen.getByText('The live connection dropped. Retrying automatically.'),
    ).toBeInTheDocument()
  })

  it('is a polite live region, not a modal', () => {
    render(<LiveReconnectBanner onConnectManually={vi.fn()} />)

    const banner = screen.getByTestId('gateway-live-reconnect-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveAttribute('aria-live', 'polite')
    // Non-blocking is the whole point — it must never trap the workspace.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers the manual escape and fires its handler', async () => {
    // Without this the client retries forever, so a Gateway that never comes back
    // would pin the app on 'reconnecting' with no route to the connect form.
    const user = userEvent.setup()
    const onConnectManually = vi.fn()
    render(<LiveReconnectBanner onConnectManually={onConnectManually} />)

    await user.click(screen.getByRole('button', { name: 'Connect manually' }))

    expect(onConnectManually).toHaveBeenCalledOnce()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<LiveReconnectBanner onConnectManually={vi.fn()} />)
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
