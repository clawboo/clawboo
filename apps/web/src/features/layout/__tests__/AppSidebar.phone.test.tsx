// At phone width the sidebar cannot dock: the team rail and the agent column
// together are wider than most of the screen. It opens as a drawer over the
// content instead, from the toggle at the start of each view's header, and gets
// out of the way again on Escape, a tap beside it, or the move to another view.
//
// The drawer keeps its own state. Opening it must never write the docked
// sidebar's collapsed preference, which the same browser reads when it is wide.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockPhoneViewport, type PhoneViewport } from '@/__vitest__/phoneViewport'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useViewStore } from '@/stores/view'

import { AppSidebar } from '../AppSidebar'
import { closePhoneNav, usePhoneNav } from '../phoneLayout'
import { CollapsedSidebarToggle } from '../SidebarToggle'

// The columns' own contents are not under test here, only where they sit. Each
// holds one button, so focus has somewhere to go inside the drawer.
vi.mock('@/features/layout/TeamSidebar', () => ({
  TeamSidebar: () => (
    <div data-testid="team-rail">
      <button type="button">First in the rail</button>
    </div>
  ),
}))
vi.mock('@/features/layout/AgentListColumn', () => ({
  AgentListColumn: () => (
    <div data-testid="agent-column">
      <button type="button">Last in the column</button>
    </div>
  ),
}))

let viewport: PhoneViewport

function renderShell() {
  return render(
    <>
      <header>
        <CollapsedSidebarToggle />
      </header>
      <main>
        <button type="button">On the page</button>
      </main>
      <AppSidebar />
    </>,
  )
}

const drawerOpen = () => !screen.getByTestId('sidebar-drawer').hasAttribute('inert')

beforeEach(() => {
  closePhoneNav()
  useSettingsModalStore.setState({ open: false })
  useViewStore.setState({ columnCollapsed: false, viewMode: { type: 'nav', view: 'board' } })
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  viewport.restore()
})

describe('AppSidebar at phone width', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(true)
  })

  it('does not dock beside the content; it starts closed', () => {
    renderShell()
    expect(screen.queryByTestId('app-sidebar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-resize-handle')).not.toBeInTheDocument()
    expect(drawerOpen()).toBe(false)
  })

  it('opens from the header toggle, even though the docked sidebar is not collapsed', async () => {
    renderShell()
    const toggle = screen.getByTestId('sidebar-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(drawerOpen()).toBe(true)
    expect(screen.getByTestId('sidebar-drawer')).toContainElement(screen.getByTestId('team-rail'))
    expect(screen.getByTestId('sidebar-drawer')).toContainElement(
      screen.getByTestId('agent-column'),
    )
  })

  it('closes on Escape, and on a tap beside it', async () => {
    renderShell()
    await userEvent.click(screen.getByTestId('sidebar-toggle'))
    await userEvent.keyboard('{Escape}')
    expect(drawerOpen()).toBe(false)

    await userEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(drawerOpen()).toBe(true)
    await userEvent.click(screen.getByTestId('sidebar-drawer-scrim'))
    expect(drawerOpen()).toBe(false)
  })

  it('keeps Tab inside while it is open, and gives focus back to the toggle on close', async () => {
    renderShell()
    const toggle = screen.getByTestId('sidebar-toggle')
    await userEvent.click(toggle)
    const first = screen.getByRole('button', { name: 'First in the rail' })
    const last = screen.getByRole('button', { name: 'Last in the column' })
    // Moved in on the next frame, past the drawer's slide.
    await waitFor(() => expect(first).toHaveFocus())

    await userEvent.tab()
    expect(last).toHaveFocus()
    // Past the last control, Tab wraps to the first rather than leaving for the
    // page under the scrim.
    await userEvent.tab()
    expect(first).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(last).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(drawerOpen()).toBe(false)
    expect(toggle).toHaveFocus()
  })

  it('leaves Tab alone while it is closed', async () => {
    // The drawer stays mounted while closed, so a trap held for its whole
    // lifetime would pull Tab from the page into it.
    renderShell()
    screen.getByTestId('sidebar-toggle').focus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'On the page' })).toHaveFocus()
  })

  it('closes when Settings opens, and stays closed after Settings does', async () => {
    renderShell()
    await userEvent.click(screen.getByTestId('sidebar-toggle'))
    act(() => useSettingsModalStore.getState().openSettings())
    expect(drawerOpen()).toBe(false)
    act(() => useSettingsModalStore.getState().close())
    expect(drawerOpen()).toBe(false)
    expect(usePhoneNav.getState().open).toBe(false)
  })

  it('closes when the person moves to another view', async () => {
    renderShell()
    await userEvent.click(screen.getByTestId('sidebar-toggle'))
    act(() => useViewStore.getState().openAgent('a1'))
    expect(drawerOpen()).toBe(false)
  })

  it('toggles the drawer on Cmd+\\, leaving the docked preference alone', () => {
    renderShell()
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    expect(usePhoneNav.getState().open).toBe(true)
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    expect(usePhoneNav.getState().open).toBe(false)
    expect(useViewStore.getState().columnCollapsed).toBe(false)
  })

  it('never writes the docked sidebar preference', async () => {
    renderShell()
    await userEvent.click(screen.getByTestId('sidebar-toggle'))
    await userEvent.keyboard('{Escape}')
    expect(useViewStore.getState().columnCollapsed).toBe(false)
    expect(localStorage.getItem('clawboo.sidebar.collapsed')).toBeNull()
  })

  it('docks again, closed, once the window is wide', async () => {
    renderShell()
    await userEvent.click(screen.getByTestId('sidebar-toggle'))
    act(() => viewport.set(false))
    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-drawer')).not.toBeInTheDocument()
    expect(usePhoneNav.getState().open).toBe(false)
    // Docked and open, so the header has no expand toggle.
    expect(screen.queryByTestId('sidebar-toggle')).not.toBeInTheDocument()
  })
})

describe('AppSidebar on a wide window', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(false)
  })

  it('docks beside the content with its resize handle, and no drawer', () => {
    renderShell()
    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-resize-handle')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-drawer')).not.toBeInTheDocument()
  })

  it('still collapses on Cmd+\\', () => {
    renderShell()
    fireEvent.keyDown(window, { key: '\\', metaKey: true })
    expect(useViewStore.getState().columnCollapsed).toBe(true)
    expect(usePhoneNav.getState().open).toBe(false)
  })
})
