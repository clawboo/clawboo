// Settings modal: open/close, grouped nav + view switching, keyword filter.
// NAV_PANELS is stubbed so the modal renders a lightweight placeholder per view
// instead of pulling the real (fetch-heavy) panels into jsdom.

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/layout/navPanels', () => ({
  NAV_PANELS: new Proxy(
    {},
    {
      get:
        (_t, view: string) =>
        () => <div data-testid={`stub-panel-${view}`}>panel:{view}</div>,
    },
  ),
}))

import { SettingsModal } from '../SettingsModal'
import { useSettingsModalStore } from '@/stores/settingsModal'

afterEach(() => {
  cleanup()
  act(() => useSettingsModalStore.setState({ open: false, view: 'runtimes' }))
})

describe('SettingsModal', () => {
  it('renders nothing while closed', () => {
    render(<SettingsModal />)
    expect(screen.queryByTestId('settings-modal')).toBeNull()
  })

  it('opens with grouped nav + the default panel, and switches views', async () => {
    const user = userEvent.setup()
    render(<SettingsModal />)
    act(() => useSettingsModalStore.getState().openSettings())

    expect(screen.getByTestId('settings-modal')).toBeInTheDocument()
    // one item from each group + the default view's stub panel
    expect(screen.getByTestId('settings-nav-runtimes')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-cost')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-system')).toBeInTheDocument()
    expect(screen.getByTestId('stub-panel-runtimes')).toBeInTheDocument()

    await user.click(screen.getByTestId('settings-nav-system'))
    expect(screen.getByTestId('stub-panel-system')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-panel-runtimes')).toBeNull()
  })

  it('filters the nav by keyword search', async () => {
    const user = userEvent.setup()
    render(<SettingsModal />)
    act(() => useSettingsModalStore.getState().openSettings())

    await user.type(screen.getByLabelText('Search settings'), 'budget')
    // "budget" is a keyword on Tokens Used + Governance only
    expect(screen.getByTestId('settings-nav-cost')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-governance')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-runtimes')).toBeNull()
    expect(screen.queryByTestId('settings-nav-system')).toBeNull()
  })

  it('the close button dismisses the modal', async () => {
    const user = userEvent.setup()
    render(<SettingsModal />)
    act(() => useSettingsModalStore.getState().openSettings())
    expect(useSettingsModalStore.getState().open).toBe(true)

    await user.click(screen.getByTestId('settings-close'))
    expect(useSettingsModalStore.getState().open).toBe(false)
  })
})
