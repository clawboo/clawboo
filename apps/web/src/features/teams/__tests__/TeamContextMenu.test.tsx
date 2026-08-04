// The team context menu — the sibling of GraphContextMenu, and it carried the
// same gaps (no roles, no keyboard path). Fixed symmetrically via the shared
// useMenuKeyboard hook, so this suite is the trimmed mirror of that one.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'

import { TeamContextMenu } from '../TeamContextMenu'

afterEach(() => cleanup())

function renderMenu(overrides: Partial<Parameters<typeof TeamContextMenu>[0]> = {}) {
  const props = {
    x: 40,
    y: 40,
    teamName: 'Research Lab',
    isArchived: false,
    onClose: vi.fn(),
    onArchive: vi.fn(),
    onRefreshProtocol: vi.fn(),
    onDelete: vi.fn(),
    onDeleteWithAgents: vi.fn(),
    ...overrides,
  }
  return { ...render(<TeamContextMenu {...props} />), props }
}

describe('TeamContextMenu', () => {
  it('is a named menu of menuitems', () => {
    renderMenu()
    expect(screen.getByRole('menu', { name: 'Actions for Research Lab' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Archive',
      'Refresh Protocol',
      'Delete team only',
      'Delete with agents',
    ])
  })

  it('flips the archive item when the team is archived', () => {
    renderMenu({ isArchived: true })
    expect(screen.getByRole('menuitem', { name: 'Unarchive' })).toBeInTheDocument()
  })

  it('focuses the first item and navigates with the arrow keys', async () => {
    const user = userEvent.setup()
    renderMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus())

    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Delete with agents' })).toHaveFocus()
  })

  it('activates the focused item with Enter', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus())

    await user.keyboard('{ArrowDown}{Enter}')
    expect(props.onRefreshProtocol).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = renderMenu()
    expect(await axe(container)).toHaveNoViolations()
  })
})
