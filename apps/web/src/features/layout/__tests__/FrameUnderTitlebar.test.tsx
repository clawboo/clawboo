// The sidebar under the slim top bar. The bar holds the one sidebar toggle, so
// the agent column, the rail, the peek and the view header show none of their
// own; and everything right of the rail is one sheet whose top and left edges
// carry the divider line, meeting in a rounded top-left corner. Without the bar
// both stay as they were: the toggle in the column, and no corner.

import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetBoardPerson } from '@/features/board/useBoardPerson'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useViewStore } from '@/stores/view'

import { AppSidebar } from '../AppSidebar'
import { EmbedTitlebar } from '../EmbedTitlebar'
import { SHEET_RADIUS } from '../railMetrics'
import { CollapsedSidebarToggle } from '../SidebarToggle'
import { closePeek } from '../sidebarPeek'

const ATTRIBUTE = 'data-clawboo-embed-titlebar'

/** The shell's pieces as App lays them out: the bar (only with the attribute),
 *  the sidebar, and a view whose header leads with the collapsed toggle. */
function renderShell(): ReturnType<typeof render> {
  const ui: ReactElement = (
    <ThemeProvider>
      {document.documentElement.hasAttribute(ATTRIBUTE) && <EmbedTitlebar />}
      <AppSidebar />
      <main>
        <header data-testid="view-header">
          <CollapsedSidebarToggle />
        </header>
      </main>
    </ThemeProvider>
  )
  return render(ui)
}

beforeEach(() => {
  resetBoardPerson()
  localStorage.clear()
  closePeek()
  useViewStore.setState({ columnCollapsed: false, viewMode: { type: 'nav', view: 'board' } })
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(ATTRIBUTE)
})

describe('one sidebar toggle', () => {
  it('without the bar: in the agent column while docked, in the view header once collapsed', () => {
    const { unmount } = renderShell()
    expect(screen.getAllByTestId('sidebar-toggle')).toHaveLength(1)
    expect(
      within(screen.getByTestId('agent-list-column')).getByTestId('sidebar-toggle'),
    ).toBeInTheDocument()
    unmount()

    useViewStore.setState({ columnCollapsed: true })
    renderShell()
    expect(
      within(screen.getByTestId('view-header')).getByTestId('sidebar-toggle'),
    ).toBeInTheDocument()
  })

  it('with the bar: only in the bar, docked or collapsed, and none in the peek', () => {
    document.documentElement.setAttribute(ATTRIBUTE, '')
    const { unmount } = renderShell()
    const bar = screen.getByTestId('embed-titlebar')
    expect(screen.getAllByTestId('sidebar-toggle')).toHaveLength(1)
    expect(within(bar).getByTestId('sidebar-toggle')).toHaveAccessibleName('Collapse sidebar')
    unmount()

    useViewStore.setState({ columnCollapsed: true })
    renderShell()
    expect(screen.getAllByTestId('sidebar-toggle')).toHaveLength(1)
    expect(
      within(screen.getByTestId('embed-titlebar')).getByTestId('sidebar-toggle'),
    ).toHaveAccessibleName('Expand sidebar')
    // The peek starts under the bar, whose toggle stays in reach above it.
    expect(within(screen.getByTestId('sidebar-peek')).queryByTestId('sidebar-toggle')).toBeNull()
    expect(within(screen.getByTestId('view-header')).queryByTestId('sidebar-toggle')).toBeNull()
  })

  it("with the bar on Boo Zero's page: the rail holds none either", () => {
    document.documentElement.setAttribute(ATTRIBUTE, '')
    useViewStore.setState({ viewMode: { type: 'booZero' } })
    renderShell()
    expect(screen.getAllByTestId('sidebar-toggle')).toHaveLength(1)
    expect(within(screen.getByTestId('team-sidebar')).queryByTestId('sidebar-toggle')).toBeNull()
  })
})

describe('the sheet right of the rail', () => {
  it('opens with the agent column: a top and left line meeting in a rounded corner', () => {
    document.documentElement.setAttribute(ATTRIBUTE, '')
    renderShell()
    const column = screen.getByTestId('agent-column-body')
    expect(column).toHaveClass('border-t', 'border-l')
    expect(column.style.borderTopLeftRadius).toBe(`${SHEET_RADIUS}px`)
    expect(SHEET_RADIUS).toBe(12)
    // The column draws the line beside the rail, so the rail does not double it.
    expect(screen.getByTestId('team-sidebar')).not.toHaveClass('border-r')
  })

  it('comes along in the collapsed peek', () => {
    document.documentElement.setAttribute(ATTRIBUTE, '')
    useViewStore.setState({ columnCollapsed: true })
    renderShell()
    const column = within(screen.getByTestId('sidebar-peek')).getByTestId('agent-column-body')
    expect(column.style.borderTopLeftRadius).toBe(`${SHEET_RADIUS}px`)
  })

  it("leaves the rail's edge on Boo Zero's page, where the page opens the sheet", () => {
    document.documentElement.setAttribute(ATTRIBUTE, '')
    useViewStore.setState({ viewMode: { type: 'booZero' } })
    renderShell()
    // Docked without a column, the page beside the rail draws the line (App.tsx).
    expect(screen.getByTestId('team-sidebar')).not.toHaveClass('border-r')
  })

  it('is not there without the bar: the column and rail keep their old edges', () => {
    renderShell()
    const column = screen.getByTestId('agent-column-body')
    expect(column).not.toHaveClass('border-t')
    expect(column).not.toHaveClass('border-l')
    expect(column.style.borderTopLeftRadius).toBe('')
    expect(screen.getByTestId('team-sidebar')).toHaveClass('border-r')
  })
})
