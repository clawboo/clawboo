// The account bar along the bottom of the sidebar. Its name is the person the
// server verified (GET /api/access/identity), or the install's own built-in
// person, said as such; never one made up. It holds the theme switch and the
// Settings gear, both under the testids e2e and the tour look for, and it sits
// under the team rail and the agent column alike.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { resetBoardPerson } from '@/features/board/useBoardPerson'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useViewStore } from '@/stores/view'

import { AccountBar, describeAccount, initialsOf } from '../AccountBar'
import { AppSidebar } from '../AppSidebar'

const renderIn = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

function identity(you: { id: string; name: string | null; role?: string | null }) {
  server.use(
    http.get('/api/access/identity', () =>
      HttpResponse.json({
        proxyIdentity: 'on',
        appLink: false,
        person: you,
        you: { role: null, ...you },
      }),
    ),
  )
}

beforeEach(() => {
  resetBoardPerson()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  useSettingsModalStore.setState({ open: false })
  useViewStore.setState({ columnCollapsed: false, viewMode: { type: 'nav', view: 'board' } })
})
afterEach(() => cleanup())

describe('who the account bar names', () => {
  it('says You and Local install when nothing verified who is here', async () => {
    renderIn(<AccountBar />)
    const bar = screen.getByTestId('account-bar')
    await waitFor(() => expect(within(bar).getByTestId('account-name')).toHaveTextContent('You'))
    expect(within(bar).getByTestId('account-detail')).toHaveTextContent('Local install')
    // No initials for nobody in particular: a plain person icon.
    expect(within(bar).getByTestId('account-avatar').querySelector('svg')).not.toBeNull()
  })

  it("shows the name a sign-in proxy verified, with the person's initials", async () => {
    identity({ id: 'alice@corp.example', name: 'Alice Example' })
    renderIn(<AccountBar />)
    await waitFor(() =>
      expect(screen.getByTestId('account-name')).toHaveTextContent('Alice Example'),
    )
    expect(screen.getByTestId('account-detail')).toHaveTextContent('Signed in via your proxy')
    expect(screen.getByTestId('account-avatar')).toHaveTextContent('AE')
  })

  it('says so when the person came from the app that started the engine', async () => {
    identity({ id: 'account:42', name: 'Sam' })
    renderIn(<AccountBar />)
    await waitFor(() => expect(screen.getByTestId('account-name')).toHaveTextContent('Sam'))
    expect(screen.getByTestId('account-detail')).toHaveTextContent('Signed in via the app')
  })

  it('names no one until the server has said who is here, and while it cannot', async () => {
    let answered = 0
    server.use(
      http.get('/api/access/identity', () => {
        answered += 1
        return new HttpResponse(null, { status: 500 })
      }),
    )
    renderIn(<AccountBar />)
    const bar = screen.getByTestId('account-bar')
    await waitFor(() => expect(answered).toBeGreaterThan(0))
    // No "You", no "Local install": a verified person would be misnamed by either.
    expect(within(bar).queryByTestId('account-name')).not.toBeInTheDocument()
    expect(within(bar).getByTestId('account-pending')).toHaveTextContent(
      'Checking who is signed in',
    )
    expect(bar).toHaveAttribute('aria-busy', 'true')
    // The controls work all the same.
    expect(within(bar).getByTestId('nav-settings')).toBeEnabled()
  })

  it('works out the words from the person alone', () => {
    expect(describeAccount({ id: 'local', name: 'You', role: null })).toEqual({
      name: 'You',
      detail: 'Local install',
      verified: false,
    })
    // A verified person with no name is shown by what the server has: the id.
    expect(describeAccount({ id: 'bob', name: null, role: null }).name).toBe('bob')
    expect(describeAccount({ id: 'account:u-7', name: null, role: null }).name).toBe('u-7')
    expect(initialsOf('Alice Example')).toBe('AE')
    expect(initialsOf('priya')).toBe('P')
    expect(initialsOf('Ana María de la Cruz')).toBe('AC')
  })
})

describe('what the account bar holds', () => {
  it('the theme switch, under its testids, and it switches the theme', async () => {
    renderIn(<AccountBar />)
    const bar = screen.getByTestId('account-bar')
    expect(within(bar).getByTestId('theme-toggle')).toBeInTheDocument()
    await userEvent.click(within(bar).getByTestId('theme-option-dark'))
    expect(within(bar).getByTestId('theme-option-dark')).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement).toHaveClass('dark')
  })

  it('the Settings gear, nav-settings, which opens Settings', async () => {
    renderIn(<AccountBar />)
    const gear = within(screen.getByTestId('account-bar')).getByTestId('nav-settings')
    expect(gear).toHaveAccessibleName('Settings')
    await userEvent.click(gear)
    expect(useSettingsModalStore.getState().open).toBe(true)
  })

  it('stacks to fit a sidebar that is only the team rail', async () => {
    renderIn(<AccountBar compact />)
    const bar = screen.getByTestId('account-bar')
    expect(bar).toHaveAttribute('data-layout', 'stacked')
    expect(within(bar).getByTestId('theme-toggle')).toHaveClass('flex-col')
    expect(within(bar).getByTestId('nav-settings')).toBeInTheDocument()
    // The name is still there for a screen reader.
    await waitFor(() =>
      expect(within(bar).getByTestId('account-name')).toHaveTextContent('You, Local install'),
    )
  })

  it('has no accessibility violations', async () => {
    const { container } = renderIn(<AccountBar />)
    await screen.findByText('Local install')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('where the account bar sits', () => {
  it('under the rail and the column, in neither of them', async () => {
    renderIn(<AppSidebar />)
    const bar = screen.getByTestId('account-bar')
    const strip = screen.getByTestId('account-strip')
    expect(strip).toContainElement(bar)
    expect(screen.getByTestId('team-sidebar')).not.toContainElement(bar)
    expect(screen.getByTestId('agent-list-column')).not.toContainElement(bar)
    // The strip is the frame's last row, under the row that holds both columns.
    const frame = screen.getByTestId('sidebar-frame')
    expect(frame.lastElementChild).toBe(strip)
    expect(frame.firstElementChild).toContainElement(screen.getByTestId('team-sidebar'))
    expect(frame.firstElementChild).toContainElement(screen.getByTestId('agent-list-column'))
    // One gear and one theme switch in the whole sidebar.
    expect(screen.getAllByTestId('nav-settings')).toHaveLength(1)
    expect(screen.getAllByTestId('theme-toggle')).toHaveLength(1)
    await screen.findByText('Local install')
  })

  it('is exactly the rail and the column wide, so a long name truncates instead of widening it', async () => {
    identity({ id: 'sanjay.reddy@corp.example.com', name: null })
    useViewStore.setState({ sidebarWidth: 176 })
    renderIn(<AppSidebar />)
    expect(screen.getByTestId('sidebar-frame').style.width).toBe(`${72 + 176}px`)
    await waitFor(() =>
      expect(screen.getByTestId('account-name')).toHaveTextContent('sanjay.reddy@corp.example.com'),
    )
    expect(screen.getByTestId('account-name')).toHaveClass('truncate')
  })

  it("stands upright on Boo Zero's page, where the sidebar is only the rail", async () => {
    useViewStore.setState({ viewMode: { type: 'booZero' } })
    renderIn(<AppSidebar />)
    expect(screen.queryByTestId('agent-list-column')).not.toBeInTheDocument()
    expect(screen.getByTestId('account-bar')).toHaveAttribute('data-layout', 'stacked')
    expect(screen.getByTestId('sidebar-frame').style.width).toBe('72px')
    await screen.findByText('You, Local install')
  })

  it('comes along in the collapsed sidebar’s hover peek, so both controls stay reachable', async () => {
    useViewStore.setState({ columnCollapsed: true })
    renderIn(<AppSidebar />)
    const peek = screen.getByTestId('sidebar-peek')
    expect(within(peek).getByTestId('nav-settings')).toBeInTheDocument()
    expect(within(peek).getByTestId('theme-toggle')).toBeInTheDocument()
    await screen.findByText('Local install')
  })
})
