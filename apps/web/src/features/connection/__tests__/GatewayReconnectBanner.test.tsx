import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GatewayReconnectBanner } from '../GatewayReconnectBanner'

afterEach(() => cleanup())

const base = {
  reason: 'offline' as const,
  phase: 'idle' as const,
  error: null,
  onReconnect: vi.fn(),
  onOpenSettings: vi.fn(),
  onDismiss: vi.fn(),
}

describe('GatewayReconnectBanner', () => {
  it('idle: shows the reason + reassuring subtitle, and Reconnect / Dismiss fire their handlers', async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()
    const onDismiss = vi.fn()
    render(<GatewayReconnectBanner {...base} onReconnect={onReconnect} onDismiss={onDismiss} />)

    expect(screen.getByText('OpenClaw Gateway is offline')).toBeInTheDocument()
    // Honest, reassuring copy — the rest of the workspace keeps working.
    expect(
      screen.getByText('Your OpenClaw agents are paused. Everything else keeps working.'),
    ).toBeInTheDocument()

    await user.click(screen.getByTestId('gateway-reconnect-action'))
    expect(onReconnect).toHaveBeenCalledOnce()

    await user.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('reason "unreachable" surfaces the unreachable title', () => {
    render(<GatewayReconnectBanner {...base} reason="unreachable" />)
    expect(screen.getByText('OpenClaw Gateway is unreachable')).toBeInTheDocument()
  })

  it('reconnecting: the action shows progress and is disabled', () => {
    render(<GatewayReconnectBanner {...base} phase="reconnecting" />)
    const btn = screen.getByTestId('gateway-reconnect-action')
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent(/reconnecting/i)
  })

  it('success: confirms reconnection and hides the action row (auto-dismisses)', () => {
    render(<GatewayReconnectBanner {...base} phase="success" />)
    expect(screen.getByText('Gateway reconnected')).toBeInTheDocument()
    expect(screen.getByText('Your OpenClaw agents are back online.')).toBeInTheDocument()
    expect(screen.queryByTestId('gateway-reconnect-action')).not.toBeInTheDocument()
  })

  it('error: shows the detail, a Retry action, and a Settings escape that fires onOpenSettings', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(
      <GatewayReconnectBanner
        {...base}
        phase="error"
        error="This device needs approval. Open Settings to approve it."
        onOpenSettings={onOpenSettings}
      />,
    )
    expect(screen.getByText('Could not reconnect')).toBeInTheDocument()
    expect(
      screen.getByText('This device needs approval. Open Settings to approve it.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('gateway-reconnect-action')).toHaveTextContent(/retry/i)

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })
})
