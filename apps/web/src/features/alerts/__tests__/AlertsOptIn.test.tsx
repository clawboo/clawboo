// The board's offer of browser alerts: shown once, explained, and the only
// place (with Settings) that asks the browser for permission, on a click.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { useToastStore } from '@/stores/toast'

import { useAlertPrefs } from '../alertPrefs'
import { AlertsOptIn } from '../AlertsOptIn'

const requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted')

beforeEach(() => {
  requestPermission.mockClear()
  vi.stubGlobal('Notification', { permission: 'default', requestPermission })
  useAlertPrefs.setState({ choice: null, permission: 'default' })
  useToastStore.setState({ toasts: [] })
  localStorage.removeItem('clawboo.alerts.needsYou')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as { clawbooDesktop?: unknown }).clawbooDesktop
})

describe('AlertsOptIn', () => {
  it('offers alerts with an explanation, and does not ask the browser by itself', async () => {
    const { container } = render(<AlertsOptIn />)
    expect(
      screen.getByText(
        'Get an alert when something needs you, even with this tab in the background',
      ),
    ).toBeInTheDocument()
    const turnOn = screen.getByRole('button', { name: 'Turn on' })
    expect(turnOn).toHaveAccessibleDescription(/fails, stops responding, is blocked/)
    expect(requestPermission).not.toHaveBeenCalled()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('asks the browser on Turn on, and keeps the choice once it is allowed', async () => {
    render(<AlertsOptIn />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    })
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(useAlertPrefs.getState().choice).toBe('on')
    expect(localStorage.getItem('clawboo.alerts.needsYou')).toBe('on')
    expect(screen.queryByTestId('alerts-opt-in')).toBeNull()
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/Alerts are on/)
  })

  it('stays put when the person closes the browser prompt without answering', async () => {
    requestPermission.mockResolvedValueOnce('default')
    render(<AlertsOptIn />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    })
    expect(useAlertPrefs.getState().choice).toBeNull()
    expect(screen.getByTestId('alerts-opt-in')).toBeInTheDocument()
  })

  it('puts the offer away on Not now, without asking the browser', () => {
    render(<AlertsOptIn />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(requestPermission).not.toHaveBeenCalled()
    expect(useAlertPrefs.getState().choice).toBe('off')
    expect(screen.queryByTestId('alerts-opt-in')).toBeNull()
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/Settings, under System/)
  })

  it('offers nothing once decided, when the browser blocks it, or inside the desktop app', () => {
    useAlertPrefs.setState({ choice: 'off' })
    const { rerender } = render(<AlertsOptIn />)
    expect(screen.queryByTestId('alerts-opt-in')).toBeNull()

    useAlertPrefs.setState({ choice: null, permission: 'denied' })
    rerender(<AlertsOptIn />)
    expect(screen.queryByTestId('alerts-opt-in')).toBeNull()

    useAlertPrefs.setState({ permission: null })
    rerender(<AlertsOptIn />)
    expect(screen.queryByTestId('alerts-opt-in')).toBeNull()

    useAlertPrefs.setState({ permission: 'default' })
    ;(window as { clawbooDesktop?: unknown }).clawbooDesktop = { isDesktop: true }
    rerender(<AlertsOptIn />)
    expect(screen.queryByTestId('alerts-opt-in')).toBeNull()
  })
})
