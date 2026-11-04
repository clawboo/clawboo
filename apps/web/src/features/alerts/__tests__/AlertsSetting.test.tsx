// Settings, System, Alerts: the switch that turns browser alerts off (and on),
// and what it says when the browser or the desktop app decides instead.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'

import { useAlertPrefs } from '../alertPrefs'
import { AlertsSetting } from '../AlertsSetting'

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static shown: string[] = []
  onclick: (() => void) | null = null
  constructor(title: string) {
    FakeNotification.shown.push(title)
  }
  close(): void {}
}

beforeEach(() => {
  FakeNotification.permission = 'granted'
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', FakeNotification)
  useAlertPrefs.setState({ choice: 'on', permission: 'granted' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as { clawbooDesktop?: unknown }).clawbooDesktop
})

const toggle = () => screen.getByRole('switch', { name: 'Alert me when something needs you' })

describe('AlertsSetting', () => {
  it('turns alerts off, and on again', async () => {
    const { container } = render(<AlertsSetting />)
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
    expect(await axe(container)).toHaveNoViolations()

    fireEvent.click(toggle())
    expect(useAlertPrefs.getState().choice).toBe('off')
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('button', { name: 'Send a test alert' })).toBeNull()

    await act(async () => {
      fireEvent.click(toggle())
    })
    expect(useAlertPrefs.getState().choice).toBe('on')
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
  })

  it('asks the browser when it has not been asked yet', async () => {
    FakeNotification.permission = 'default'
    useAlertPrefs.setState({ choice: null, permission: 'default' })
    render(<AlertsSetting />)
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'granted'
      return 'granted'
    })
    await act(async () => {
      fireEvent.click(toggle())
    })
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(useAlertPrefs.getState().choice).toBe('on')
    expect(toggle()).toHaveAttribute('aria-checked', 'true')
  })

  it('sends a test alert', () => {
    render(<AlertsSetting />)
    fireEvent.click(screen.getByRole('button', { name: 'Send a test alert' }))
    expect(FakeNotification.shown).toEqual(['Alerts are working'])
  })

  it('says how to unblock it when the browser blocks notifications', () => {
    FakeNotification.permission = 'denied'
    useAlertPrefs.setState({ choice: 'on', permission: 'denied' })
    render(<AlertsSetting />)
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('note')).toHaveTextContent(/blocking notifications from this page/)
  })

  it('explains that the desktop app tells you instead', () => {
    ;(window as { clawbooDesktop?: unknown }).clawbooDesktop = { isDesktop: true }
    render(<AlertsSetting />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByTestId('alerts-setting')).toHaveTextContent(/The Clawboo app tells you/)
  })

  it('says so when the browser cannot show alerts at all', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('Notification', undefined)
    useAlertPrefs.setState({ permission: null })
    render(<AlertsSetting />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByTestId('alerts-setting')).toHaveTextContent(/cannot show alerts/)
  })
})
