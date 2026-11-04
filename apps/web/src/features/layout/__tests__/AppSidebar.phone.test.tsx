// At phone width the sidebar cannot dock: the team rail and the agent column
// together are wider than most of the screen. It opens as a drawer over the
// content instead, from the toggle at the start of each view's header, and gets
// out of the way again on Escape, a tap beside it, or the move to another view.
//
// The drawer keeps its own state. Opening it must never write the docked
// sidebar's collapsed preference, which the same browser reads when it is wide.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockPhoneViewport, type PhoneViewport } from '@/__vitest__/phoneViewport'
import { useViewStore } from '@/stores/view'

import { AppSidebar } from '../AppSidebar'
import { closePhoneNav, usePhoneNav } from '../phoneLayout'
import { CollapsedSidebarToggle } from '../SidebarToggle'

// The columns' own contents are not under test here, only where they sit.
vi.mock('@/features/layout/TeamSidebar', () => ({
  TeamSidebar: () => <div data-testid="team-rail" />,
}))
vi.mock('@/features/layout/AgentListColumn', () => ({
  AgentListColumn: () => <div data-testid="agent-column" />,
}))

let viewport: PhoneViewport

function renderShell() {
  return render(
    <>
      <header>
        <CollapsedSidebarToggle />
      </header>
      <AppSidebar />
    </>,
  )
}

const drawerOpen = () => !screen.getByTestId('sidebar-drawer').hasAttribute('inert')

beforeEach(() => {
  closePhoneNav()
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
