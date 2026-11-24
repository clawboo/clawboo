// The app shell honours `--clawboo-titlebar-inset`, so an embedder can draw its
// own title bar (an inset macOS one) above the sidebar instead of over it.
// Every heavy child is stubbed: this is about the shell's own box, not its
// contents. jsdom resolves no `var()`, so the inline declaration is the contract.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  document.documentElement.removeAttribute('data-clawboo-embed-titlebar')
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

describe('the slim top bar, opt-in only', () => {
  it('draws nothing at the top without the attribute: the browser layout is unchanged', () => {
    render(<App />)
    expect(screen.queryByTestId('embed-titlebar')).not.toBeInTheDocument()
    // The shell is exactly what it was before the bar existed.
    const shell = screen.getByTestId('app-shell')
    expect(shell.className).toBe('flex h-dvh overflow-hidden bg-background text-foreground')
    expect(shell.style.paddingTop).toBe('var(--clawboo-titlebar-inset, 0px)')
    // No sheet line or corner on the page either.
    const main = screen.getByTestId('app-main')
    expect(main.className).toBe('flex flex-1 flex-col overflow-hidden')
    expect(main.style.borderTopLeftRadius).toBe('')
  })

  it('sets the page into the frame under the bar: the top line runs on across it', () => {
    document.documentElement.setAttribute('data-clawboo-embed-titlebar', '')
    useViewStore.setState({ viewMode: { type: 'nav', view: 'board' }, columnCollapsed: false })
    render(<App />)
    // The frame colour shows around the sheet's corner.
    expect(screen.getByTestId('app-shell')).toHaveClass('bg-frame')
    const main = screen.getByTestId('app-main')
    expect(main).toHaveClass('border-t', 'bg-background')
    // The agent column opens the sheet here, so the page takes no corner.
    expect(main).not.toHaveClass('border-l')
    expect(main.style.borderTopLeftRadius).toBe('')
  })

  it("gives the page the rounded corner on Boo Zero's page, which has no agent column", () => {
    document.documentElement.setAttribute('data-clawboo-embed-titlebar', '')
    useViewStore.setState({ viewMode: { type: 'booZero' }, columnCollapsed: false })
    useBooZeroStore.setState({ booZeroAgentId: 'b0' })
    render(<App />)
    const main = screen.getByTestId('app-main')
    expect(main).toHaveClass('border-t', 'border-l')
    expect(main.style.borderTopLeftRadius).toBe('12px')
  })

  it('takes no corner while the sidebar is collapsed: the page then starts at the window edge', () => {
    document.documentElement.setAttribute('data-clawboo-embed-titlebar', '')
    useViewStore.setState({ viewMode: { type: 'booZero' }, columnCollapsed: true })
    render(<App />)
    const main = screen.getByTestId('app-main')
    expect(main).toHaveClass('border-t')
    expect(main).not.toHaveClass('border-l')
    expect(main.style.borderTopLeftRadius).toBe('')
  })

  it('draws the bar inside the shell, before the sidebar, when <html> asks for it', () => {
    document.documentElement.setAttribute('data-clawboo-embed-titlebar', '')
    render(<App />)
    const bar = screen.getByTestId('embed-titlebar')
    const shell = screen.getByTestId('app-shell')
    // Inside the shell, so Settings makes it inert with the rest of the app.
    expect(shell).toContainElement(bar)
    // First in the shell, so Tab reaches it before the sidebar.
    expect(shell.firstElementChild).toBe(bar)
  })

  it('follows the attribute when the app sets it, or takes it away, after load', async () => {
    render(<App />)
    expect(screen.queryByTestId('embed-titlebar')).not.toBeInTheDocument()
    act(() => document.documentElement.setAttribute('data-clawboo-embed-titlebar', ''))
    await waitFor(() => expect(screen.getByTestId('embed-titlebar')).toBeInTheDocument())
    act(() => document.documentElement.removeAttribute('data-clawboo-embed-titlebar'))
    await waitFor(() => expect(screen.queryByTestId('embed-titlebar')).not.toBeInTheDocument())
  })
})
