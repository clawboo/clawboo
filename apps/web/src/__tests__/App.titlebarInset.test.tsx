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
vi.mock('@/features/promo/AppTopBar', () => ({ AppTopBar: () => null }))
vi.mock('@/features/settings/SettingsModal', () => ({ SettingsModal: () => null }))
vi.mock('@/features/shared/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('@/features/board/FinishPromptDialog', () => ({ FinishPromptDialog: () => null }))

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

  it('keeps the sidebar and content inside the padded shell', () => {
    render(<App />)
    const shell = screen.getByTestId('app-shell')
    expect(shell).toContainElement(screen.getByTestId('app-sidebar'))
    expect(shell).toContainElement(screen.getByTestId('content-area'))
  })
})
