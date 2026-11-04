// The app shell honours `--clawboo-titlebar-inset`, so an embedder can draw its
// own title bar (an inset macOS one) above the sidebar instead of over it.
// Every heavy child is stubbed: this is about the shell's own box, not its
// contents. jsdom resolves no `var()`, so the inline declaration is the contract.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../app/providers', () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/features/ui/ToastContainer', () => ({ ToastContainer: () => null }))
vi.mock('@/features/connection/GatewayBootstrap', () => ({ GatewayBootstrap: () => null }))
vi.mock('@/features/obs/RunStatusBridge', () => ({ RunStatusBridge: () => null }))
vi.mock('@/features/layout/AppSidebar', () => ({
  AppSidebar: () => <nav data-testid="app-sidebar" />,
}))
vi.mock('@/features/layout/ContentArea', () => ({
  ContentArea: () => <section data-testid="content-area" />,
}))
vi.mock('@/features/fleet/FirstRunNudge', () => ({ FirstRunNudge: () => null }))
vi.mock('@/features/promo/UpdateChip', () => ({ UpdateChip: () => null }))
vi.mock('@/features/promo/AppTopBar', () => ({
  AppTopBar: () => <div data-testid="app-top-bar" />,
}))
vi.mock('@/features/settings/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('@/features/shared/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/features/board/FinishPromptDialog', () => ({ FinishPromptDialog: () => null }))

import { useBooZeroStore } from '@/stores/booZero'
import { useViewStore } from '@/stores/view'

import { App } from '../App'

afterEach(() => {
  cleanup()
})

describe('App shell title-bar inset', () => {
  it('pads the shell by --clawboo-titlebar-inset, falling back to 0 when unset', () => {
    render(<App />)
    const shell = screen.getByTestId('app-shell')
    expect(shell.style.paddingTop).toBe('var(--clawboo-titlebar-inset, 0px)')
  })

  it('fills the visible viewport, not the tallest one a phone browser reports', () => {
    // `100vh` on a phone is the viewport with the browser's toolbars hidden, so
    // the bottom of the app (the chat's message box) would sit under them.
    render(<App />)
    const shell = screen.getByTestId('app-shell')
    expect(shell).toHaveClass('h-dvh')
    expect(shell).not.toHaveClass('h-screen')
  })

  it('keeps the sidebar and content inside the padded shell', () => {
    render(<App />)
    const shell = screen.getByTestId('app-shell')
    expect(shell).toContainElement(screen.getByTestId('app-sidebar'))
    expect(shell).toContainElement(screen.getByTestId('content-area'))
  })
})

describe('App top bar', () => {
  it('shows over the Boo Zero view while there is no Boo Zero, so the sidebar can be reopened', () => {
    useViewStore.setState({ viewMode: { type: 'booZero' } })
    useBooZeroStore.setState({ booZeroAgentId: null })
    render(<App />)
    expect(screen.getByTestId('app-top-bar')).toBeInTheDocument()
  })

  it('stays out of the Boo Zero view once there is one, which has its own header', () => {
    useViewStore.setState({ viewMode: { type: 'booZero' } })
    useBooZeroStore.setState({ booZeroAgentId: 'b0' })
    render(<App />)
    expect(screen.queryByTestId('app-top-bar')).not.toBeInTheDocument()
  })
})
