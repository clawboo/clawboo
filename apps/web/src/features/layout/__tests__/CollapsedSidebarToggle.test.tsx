// Collapsed, the sidebar leaves nothing on screen and the expand toggle sits in
// the view's header. It shows only while collapsed, never inside the Settings
// modal (which reuses the panels' headers), peeks on hover and docks on click.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetInboxStore, useInboxStore } from '@/features/inbox/inboxStore'
import { InSettingsModalContext } from '@/features/settings/settingsModalContext'
import { useApprovalsStore } from '@/stores/approvals'
import { useViewStore } from '@/stores/view'

import { CollapsedSidebarToggle } from '../SidebarToggle'
import { closePeek, useSidebarPeek } from '../sidebarPeek'

beforeEach(() => {
  closePeek()
  useSidebarPeek.setState({ peek: false, anchor: null })
})
afterEach(() => cleanup())

describe('CollapsedSidebarToggle', () => {
  it('renders nothing while the sidebar is open', () => {
    useViewStore.setState({ columnCollapsed: false })
    render(<CollapsedSidebarToggle />)
    expect(screen.queryByTestId('sidebar-toggle')).not.toBeInTheDocument()
  })

  it('renders nothing inside the Settings modal', () => {
    useViewStore.setState({ columnCollapsed: true })
    render(
      <InSettingsModalContext.Provider value={true}>
        <CollapsedSidebarToggle />
      </InSettingsModalContext.Provider>,
    )
    expect(screen.queryByTestId('sidebar-toggle')).not.toBeInTheDocument()
  })

  it('peeks the sidebar on hover and docks it on click', async () => {
    useViewStore.setState({ columnCollapsed: true })
    render(<CollapsedSidebarToggle />)
    const toggle = screen.getByRole('button', { name: 'Expand sidebar' })

    fireEvent.mouseEnter(toggle, { clientX: 20, clientY: 20 })
    expect(useSidebarPeek.getState().peek).toBe(true)
    expect(useSidebarPeek.getState().anchor).not.toBeNull()

    await userEvent.click(toggle)
    expect(useViewStore.getState().columnCollapsed).toBe(false)
    expect(useSidebarPeek.getState().peek).toBe(false)
  })
})

describe('the inbox on the toggle', () => {
  beforeEach(() => {
    useViewStore.setState({ columnCollapsed: true })
    resetInboxStore()
    useApprovalsStore.setState({ pendingApprovals: new Map() })
  })

  it('shows a dot while the sidebar hides the badge, and says why', () => {
    render(<CollapsedSidebarToggle />)
    expect(screen.queryByTestId('sidebar-toggle-inbox-dot')).not.toBeInTheDocument()
    cleanup()

    useInboxStore.getState().apply({
      unread: [{ id: 'a', seq: 2 }],
      needsYou: [],
      approvals: [],
      through: 2,
    })
    render(<CollapsedSidebarToggle />)
    expect(screen.getByTestId('sidebar-toggle-inbox-dot')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1 in your inbox/ })).toBeInTheDocument()
  })
})
