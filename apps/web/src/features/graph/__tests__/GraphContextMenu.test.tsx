// The Atlas per-node action menu. It was mouse-only: no roles, no focus move on
// open, no arrow navigation, and no way back to the node that opened it — the
// graph's actions were simply unreachable without a pointer.
//
// It renders standalone (react + framer-motion + lucide only, no React Flow
// context), which is why this is the first rendered graph-component test that
// needs no ReactFlowProvider.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'

import { GraphContextMenu } from '../GraphContextMenu'

afterEach(() => cleanup())

function renderMenu(overrides: Partial<Parameters<typeof GraphContextMenu>[0]> = {}) {
  const props = {
    x: 100,
    y: 100,
    agentName: 'Scout',
    onClose: vi.fn(),
    onChat: vi.fn(),
    onEditPersonality: vi.fn(),
    onEditFiles: vi.fn(),
    onSelectInSidebar: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
  return { ...render(<GraphContextMenu {...props} />), props }
}

describe('GraphContextMenu', () => {
  it('is a named menu of menuitems', () => {
    renderMenu()
    expect(screen.getByRole('menu', { name: 'Actions for Scout' })).toBeInTheDocument()
    const items = screen.getAllByRole('menuitem')
    // THREE ROWS, not five. 'Chat', 'Edit personality' and 'Edit files' were
    // byte-identical calls to the same handler, so the menu promised three
    // destinations and delivered one.
    expect(items.map((i) => i.textContent)).toEqual(['Open agent', 'Select in sidebar', 'Delete'])
  })

  it('focuses the first item on open and rovers the tabindex', async () => {
    renderMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus())

    const items = screen.getAllByRole('menuitem')
    // Exactly one tab stop, so Tab LEAVES the menu instead of walking five buttons.
    expect(items.map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
  })

  it('moves with the arrow keys and wraps at both ends', async () => {
    const user = userEvent.setup()
    renderMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus())

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Select in sidebar' })).toHaveFocus()

    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus()
  })

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup()
    renderMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus())

    await user.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()

    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus()
  })

  it('activates the focused item with Enter', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus())

    await user.keyboard('{ArrowDown}{Enter}')
    expect(props.onSelectInSidebar).toHaveBeenCalledTimes(1)
    expect(props.onChat).not.toHaveBeenCalled()
  })

  it('closes on Escape and on Tab', async () => {
    const user = userEvent.setup()
    const { props } = renderMenu()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalled()

    cleanup()
    const second = renderMenu()
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus())
    await user.tab()
    expect(second.props.onClose).toHaveBeenCalled()
  })

  it('returns focus to the element that opened it', async () => {
    function Harness() {
      return (
        <>
          <button type="button" data-testid="opener">
            Node
          </button>
        </>
      )
    }
    const { rerender } = render(<Harness />)
    const opener = screen.getByTestId('opener')
    opener.focus()

    rerender(
      <>
        <Harness />
        <GraphContextMenu
          x={0}
          y={0}
          agentName="Scout"
          onClose={vi.fn()}
          onChat={vi.fn()}
          onSelectInSidebar={vi.fn()}
          onDelete={vi.fn()}
        />
      </>,
    )
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open agent' })).toHaveFocus())

    rerender(<Harness />)
    expect(screen.getByTestId('opener')).toHaveFocus()
  })

  // Catches a missed role="none" on the layout wrappers — a role=menu may only
  // contain menuitem / group / presentation children.
  it('has no level-A/AA a11y violations', async () => {
    const { container } = renderMenu()
    expect(await axe(container)).toHaveNoViolations()
  })
})
