// The slim top bar an app that shows the dashboard in its own window asks for
// with `data-clawboo-embed-titlebar` on <html>. Its drag area is the window's,
// every control in it opts out, back and forward walk the dashboard's own
// history, and the middle names the team or the page.
//
// jsdom applies no stylesheet and resolves no var(), so the contract is the
// class each region carries plus the rule app/globals.css gives that class
// (read from the file), and the inline var() declarations.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mockPhoneViewport } from '@/__vitest__/phoneViewport'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useRoomStore, type Room } from '@/stores/rooms'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTeamStore, type Team } from '@/stores/team'
import { useViewStore } from '@/stores/view'

import { DOCS_URL, EmbedTitlebar, titlebarTitle } from '../EmbedTitlebar'
import { closePeek, useSidebarPeek } from '../sidebarPeek'

function team(id: string, name: string, over: Partial<Team> = {}): Team {
  return {
    id,
    name,
    icon: '🚀',
    color: '#10b981',
    colorCollectionId: null,
    templateId: null,
    agentCount: 1,
    leaderAgentId: null,
    isArchived: false,
    serverOrchestrated: true,
    ...over,
  }
}

const agent = (id: string, name: string, teamId: string | null): AgentState =>
  ({ id, name, teamId, status: 'idle' }) as unknown as AgentState

beforeEach(() => {
  useTeamStore.setState({ teams: [team('t1', 'Marketing')], selectedTeamId: null })
  useFleetStore.setState({ agents: [agent('a1', 'Writer Boo', 't1'), agent('a2', 'Solo', null)] })
  useRoomStore.setState({ roomsByTeam: new Map(), loadedTeams: new Set() })
  useSettingsModalStore.setState({ open: false })
  useViewStore.setState({
    viewMode: { type: 'nav', view: 'graph' },
    viewHistory: { past: [], future: [] },
    boardNeedsYouFocus: null,
    boardFocus: null,
    columnCollapsed: false,
  })
  closePeek()
})
afterEach(() => cleanup())

describe('drag regions', () => {
  it('makes the bar the window drag area and every control in it not', () => {
    render(<EmbedTitlebar />)
    const bar = screen.getByTestId('embed-titlebar')
    expect(bar).toHaveClass('clawboo-titlebar')

    const controls = bar.querySelectorAll('button, a')
    expect(controls).toHaveLength(5)
    for (const control of controls) expect(control).toHaveClass('clawboo-titlebar-control')

    // The title is part of the drag area, so a press on it moves the window.
    expect(screen.getByTestId('titlebar-title')).not.toHaveClass('clawboo-titlebar-control')
    // No handler of its own: a double-click on the bar stays the window's.
    expect(bar.getAttribute('ondblclick')).toBeNull()
  })

  it('gives those classes the app-region rules in the stylesheet', () => {
    const css = readFileSync(resolve(__dirname, '../../../app/globals.css'), 'utf8')
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(rule('.clawboo-titlebar')).toMatch(/-webkit-app-region:\s*drag;/)
    expect(rule('.clawboo-titlebar-control')).toMatch(/-webkit-app-region:\s*no-drag;/)
  })

  it('lets a dialog, drawer, menu or the file editor drawn over the bar keep its clicks', () => {
    const css = readFileSync(resolve(__dirname, '../../../app/globals.css'), 'utf8')
    const at = css.indexOf('html[data-clawboo-embed-titlebar]')
    expect(at).toBeGreaterThan(-1)
    const rule = css.slice(at, css.indexOf('}', at))
    for (const selector of [
      "[role='dialog']",
      "[role='alertdialog']",
      "[aria-modal='true']",
      "[role='menu']",
      "[role='listbox']",
      '[data-clawboo-overlay]',
    ]) {
      expect(rule).toContain(selector)
    }
    expect(rule).toMatch(/-webkit-app-region:\s*no-drag;/)
    // The file editor has no dialog role, so it carries the marker.
    const editor = readFileSync(resolve(__dirname, '../../editor/AgentFileEditor.tsx'), 'utf8')
    expect(editor).toContain('data-clawboo-overlay=""')
  })

  it('is the inset tall, and starts its controls after the window buttons', () => {
    render(<EmbedTitlebar />)
    expect(screen.getByTestId('embed-titlebar').style.height).toBe(
      'var(--clawboo-titlebar-inset, 0px)',
    )
    expect(screen.getByTestId('titlebar-left').style.marginLeft).toBe(
      'var(--clawboo-titlebar-left, 0px)',
    )
  })
})

describe('back and forward', () => {
  it('are disabled until there is somewhere to go, then walk the history', async () => {
    render(<EmbedTitlebar />)
    const back = screen.getByRole('button', { name: 'Back' })
    const forward = screen.getByRole('button', { name: 'Forward' })
    expect(back).toBeDisabled()
    expect(forward).toBeDisabled()

    act(() => {
      useViewStore.getState().openTeamspace('t1')
      useTeamStore.getState().selectTeam('t1')
      useViewStore.getState().navigateTo('board')
    })
    expect(back).toBeEnabled()
    expect(forward).toBeDisabled()

    await userEvent.click(back)
    expect(useViewStore.getState().viewMode).toEqual({ type: 'teamspace', teamId: 't1' })
    expect(forward).toBeEnabled()

    await userEvent.click(back)
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })
    expect(back).toBeDisabled()

    await userEvent.click(forward)
    expect(useViewStore.getState().viewMode).toEqual({ type: 'teamspace', teamId: 't1' })
  })

  it('stays disabled when the only page back is one that was deleted', () => {
    render(<EmbedTitlebar />)
    act(() => {
      useViewStore.getState().openAgent('a1')
      useViewStore.getState().navigateTo('board')
    })
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    act(() => {
      useViewStore.setState({
        viewHistory: { past: [{ type: 'agent', agentId: 'a1' }], future: [] },
      })
      useFleetStore.setState({ agents: [] })
    })
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('stays disabled when the only page back is a chat room that was deleted', () => {
    const r1: Room = {
      id: 'r1',
      teamId: 't1',
      name: 'Launch',
      memberIds: [],
      pinnedAt: null,
      createdAt: 0,
      updatedAt: 0,
    }
    useRoomStore.setState({ roomsByTeam: new Map([['t1', [r1]]]), loadedTeams: new Set(['t1']) })
    render(<EmbedTitlebar />)
    act(() => {
      useViewStore.getState().openGroupChat('t1', 'r1')
      useViewStore.getState().navigateTo('board')
    })
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    act(() => {
      useViewStore.setState({
        viewHistory: { past: [{ type: 'groupChat', teamId: 't1', roomId: 'r1' }], future: [] },
      })
      useRoomStore.getState().remove('t1', 'r1')
    })
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('answer Cmd+[ and Cmd+], but not while typing or under Settings', () => {
    render(
      <>
        <EmbedTitlebar />
        <input aria-label="Message" />
      </>,
    )
    act(() => useViewStore.getState().navigateTo('board'))

    fireEvent.keyDown(screen.getByLabelText('Message'), { key: '[', metaKey: true })
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'board' })

    act(() => useSettingsModalStore.setState({ open: true }))
    fireEvent.keyDown(document.body, { key: '[', metaKey: true })
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'board' })
    act(() => useSettingsModalStore.setState({ open: false }))

    fireEvent.keyDown(document.body, { key: '[', ctrlKey: true })
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })
    fireEvent.keyDown(document.body, { key: ']', metaKey: true })
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'board' })
  })
})

describe('the middle', () => {
  it("names the team, with its icon, on the team's pages and its agents' pages", () => {
    useViewStore.setState({ viewMode: { type: 'groupChat', teamId: 't1' } })
    render(<EmbedTitlebar />)
    expect(screen.getByTestId('titlebar-title')).toHaveTextContent('Marketing')
    expect(screen.getByTestId('titlebar-team-icon')).toHaveTextContent('🚀')

    act(() => useViewStore.getState().openAgent('a1'))
    expect(screen.getByTestId('titlebar-title')).toHaveTextContent('Marketing')
  })

  it('names the page everywhere else', () => {
    const teams = [team('t1', 'Marketing')]
    const agents = [agent('a2', 'Solo', null)]
    expect(titlebarTitle({ type: 'nav', view: 'board' }, teams, agents)).toEqual({
      label: 'Board',
      team: null,
    })
    expect(titlebarTitle({ type: 'nav', view: 'graph' }, teams, agents).label).toBe('Org chart')
    expect(titlebarTitle({ type: 'booZero' }, teams, agents).label).toBe('Boo Zero')
    expect(titlebarTitle({ type: 'agent', agentId: 'a2' }, teams, agents)).toEqual({
      label: 'Solo',
      team: null,
    })
    expect(titlebarTitle({ type: 'welcome' }, teams, agents).label).toBe('Clawboo')
  })
})

describe('the right side', () => {
  it('opens Needs you on the board', async () => {
    render(<EmbedTitlebar />)
    await userEvent.click(screen.getByRole('button', { name: 'Needs you' }))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'board' })
    expect(useViewStore.getState().boardNeedsYouFocus).not.toBeNull()
  })

  it('opens the docs in a new tab', () => {
    render(<EmbedTitlebar />)
    const help = screen.getByRole('link', { name: /Help/ })
    expect(help).toHaveAttribute('href', DOCS_URL)
    expect(DOCS_URL).toBe('https://docs.claw.boo')
    expect(help).toHaveAttribute('target', '_blank')
    expect(help.getAttribute('rel')).toContain('noopener')
  })

  it('puts the controls in reading order: back, forward, Needs you, help', () => {
    render(<EmbedTitlebar />)
    const names = Array.from(
      screen.getByTestId('embed-titlebar').querySelectorAll('button, a'),
    ).map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual([
      'Collapse sidebar',
      'Back',
      'Forward',
      'Needs you',
      'Help: the Clawboo docs, in a new tab',
    ])
  })
})

describe('the sidebar toggle in the bar', () => {
  it('comes first, before back, with its testid, label, shortcut and no-drag class', () => {
    render(<EmbedTitlebar />)
    const left = screen.getByTestId('titlebar-left')
    const first = left.querySelector('button')!
    expect(first).toHaveAttribute('data-testid', 'sidebar-toggle')
    expect(first).toHaveAccessibleName('Collapse sidebar')
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(first.getAttribute('title')).toContain('⌘\\')
    expect(first).toHaveClass('clawboo-titlebar-control')
    const buttons = Array.from(left.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(buttons).toEqual(['Collapse sidebar', 'Back', 'Forward'])
  })

  it('collapses the docked sidebar and expands it again', async () => {
    render(<EmbedTitlebar />)
    await userEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(useViewStore.getState().columnCollapsed).toBe(true)
    const toggle = screen.getByTestId('sidebar-toggle')
    expect(toggle).toHaveAccessibleName('Expand sidebar')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(useViewStore.getState().columnCollapsed).toBe(false)
  })

  it('lays the collapsed sidebar over the page while it is hovered', async () => {
    useViewStore.setState({ columnCollapsed: true })
    render(<EmbedTitlebar />)
    await userEvent.hover(screen.getByTestId('sidebar-toggle'))
    expect(useSidebarPeek.getState().peek).toBe(true)
  })

  it('stays out of the bar at phone width, where each view header opens the drawer', () => {
    const viewport = mockPhoneViewport(true)
    try {
      render(<EmbedTitlebar />)
      expect(screen.queryByTestId('sidebar-toggle')).not.toBeInTheDocument()
      expect(screen.getByTestId('titlebar-back')).toBeInTheDocument()
    } finally {
      cleanup()
      viewport.restore()
    }
  })
})
