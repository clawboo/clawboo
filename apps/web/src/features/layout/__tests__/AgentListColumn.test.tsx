// The agent sidebar — the surface that is on screen every session. Zero props;
// everything comes from Zustand, so the tests drive it purely with `setState`.
//
// It makes NO network calls on mount: `listAgents()` fires only from
// CreateBooModal's onCreated callback, and the modal is `{isOpen && …}`-gated.
// That is asserted directly against a spy (see the mock below) rather than left
// to msw's strict mode, which cannot see a fetch the component swallows.
//
// The <ThemeProvider> wrapper is required, not cosmetic: AgentBooAvatar (inside
// AgentAvatar and GroupChatRow) and ThemeToggle both call useTheme(), which
// THROWS outside a provider.

import type { ReactElement } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listAgents } from '@clawboo/control-client'
import type { GatewayClient } from '@clawboo/gateway-client'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'
import { useSettingsModalStore } from '@/stores/settingsModal'
import type { Team } from '@/stores/team'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'

import { AgentListColumn } from '../AgentListColumn'

// `onUnhandledRequest: 'error'` alone does NOT make "no fetch on mount" a
// guarantee here: the only caller, `handleBooCreated`, wraps `listAgents()` in a
// try/catch, so a regression that fetched on mount would swallow msw's error and
// still go green. Spy on the function itself instead.
vi.mock('@clawboo/control-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clawboo/control-client')>()),
  listAgents: vi.fn(async () => ({ defaultId: null, agents: [] })),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function agent(over: Partial<AgentState> & { id: string; name: string }): AgentState {
  return {
    status: 'idle',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    execConfig: null,
    ...over,
  }
}

function team(over: Partial<Team> & { id: string; name: string }): Team {
  return {
    icon: 'Rocket',
    color: '#E94560',
    colorCollectionId: null,
    templateId: null,
    agentCount: 0,
    leaderAgentId: null,
    isArchived: false,
    serverOrchestrated: false,
    ...over,
  }
}

const renderColumn = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

beforeEach(() => {
  vi.mocked(listAgents).mockClear()
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useBooZeroStore.setState({ booZeroAgentId: null, gatewayMainAgentId: null })
  useConnectionStore.setState({ status: 'connected', client: {} as unknown as GatewayClient })
  // The store default is `{ type: 'nav', view: 'graph' }`, which would leave the
  // Atlas row active in every test — seed an inert view instead.
  useViewStore.setState({ viewMode: { type: 'welcome' }, columnCollapsed: false })
  useSettingsModalStore.setState({ open: false })
  useChatStore.setState({ transcripts: new Map(), streamingText: new Map() })
})
afterEach(() => cleanup())

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentListColumn', () => {
  it('scopes the list to the selected team, and fetches nothing on mount', () => {
    useFleetStore.setState({
      agents: [
        agent({ id: 'a1', name: 'Research Boo', teamId: 't1' }),
        agent({ id: 'a2', name: 'Ops Boo', teamId: 't1' }),
        agent({ id: 'a3', name: 'Other Boo', teamId: 't2' }),
      ],
    })
    useTeamStore.setState({
      teams: [team({ id: 't1', name: 'Alpha' }), team({ id: 't2', name: 'Beta' })],
      selectedTeamId: 't1',
    })

    renderColumn(<AgentListColumn />)

    expect(screen.getByTestId('fleet-agent-row-a1')).toBeInTheDocument()
    expect(screen.getByTestId('fleet-agent-row-a2')).toBeInTheDocument()
    expect(screen.queryByTestId('fleet-agent-row-a3')).not.toBeInTheDocument()

    // The header shows the team name + the filtered count. Scoped to the
    // heading so a stray "2" elsewhere in the column can't satisfy it.
    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading).toHaveTextContent('Alpha')
    expect(heading).toHaveTextContent('2')
    // A team with members gets the group-chat row above the list.
    expect(screen.getByTestId('group-chat-row')).toBeInTheDocument()

    // The panel hydrates from the store, never from the network, on mount.
    expect(vi.mocked(listAgents)).not.toHaveBeenCalled()
  })

  it('hides the OpenClaw Gateway default agent — but only when it is NOT Boo Zero', () => {
    useFleetStore.setState({
      agents: [agent({ id: 'main', name: 'main' }), agent({ id: 'a1', name: 'Research Boo' })],
    })

    // Native-first install: the Gateway default is a redundant system artifact.
    useBooZeroStore.setState({ gatewayMainAgentId: 'main', booZeroAgentId: 'a1' })
    const { unmount } = renderColumn(<AgentListColumn />)
    expect(screen.queryByTestId('fleet-agent-row-main')).not.toBeInTheDocument()
    expect(screen.getByTestId('fleet-agent-row-a1')).toBeInTheDocument()
    unmount()

    // PURE-OpenClaw install: the Gateway default legitimately IS Boo Zero, so it
    // must stay visible as the leader. This carve-out is the load-bearing half.
    useBooZeroStore.setState({ gatewayMainAgentId: 'main', booZeroAgentId: 'main' })
    renderColumn(<AgentListColumn />)
    expect(screen.getByTestId('fleet-agent-row-main')).toBeInTheDocument()
  })

  it('filters by the search box and offers a way back', async () => {
    useFleetStore.setState({
      agents: [agent({ id: 'a1', name: 'Research Boo' }), agent({ id: 'a2', name: 'Ops Boo' })],
    })
    renderColumn(<AgentListColumn />)

    const search = screen.getByRole('textbox', { name: 'Search agents' })
    await userEvent.type(search, 'rese') // case-insensitive substring match

    expect(screen.getByTestId('fleet-agent-row-a1')).toBeInTheDocument()
    expect(screen.queryByTestId('fleet-agent-row-a2')).not.toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, 'zzz')
    // A non-matching QUERY short-circuits the 1s delayed empty state, so this
    // needs no fake timers.
    expect(screen.getByText('No agents match.')).toBeInTheDocument()

    await userEvent.clear(search)
    expect(screen.getByTestId('fleet-agent-row-a1')).toBeInTheDocument()
    expect(screen.getByTestId('fleet-agent-row-a2')).toBeInTheDocument()
  })

  it('clicking a row opens that agent; the nav rows navigate and open settings', async () => {
    useFleetStore.setState({ agents: [agent({ id: 'a1', name: 'Research Boo' })] })
    renderColumn(<AgentListColumn />)

    // Scoped to the row: it holds TWO buttons whose accessible names contain
    // the agent name — the select button and "Delete Research Boo".
    const row = screen.getByTestId('fleet-agent-row-a1')
    await userEvent.click(within(row).getByRole('button', { name: /^Research Boo/ }))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'agent', agentId: 'a1' })
    expect(useFleetStore.getState().selectedAgentId).toBe('a1')

    await userEvent.click(screen.getByTestId('nav-board'))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'board' })

    await userEvent.click(screen.getByTestId('nav-graph'))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })

    await userEvent.click(screen.getByTestId('nav-settings'))
    expect(useSettingsModalStore.getState().open).toBe(true)
  })

  it('has no level-A/AA a11y violations', async () => {
    useFleetStore.setState({
      agents: [
        agent({ id: 'a1', name: 'Research Boo', teamId: 't1' }),
        agent({ id: 'a2', name: 'Ops Boo', teamId: 't1' }),
      ],
    })
    useTeamStore.setState({ teams: [team({ id: 't1', name: 'Alpha' })], selectedTeamId: 't1' })

    const { container } = renderColumn(<AgentListColumn />)
    expect(await screen.findByTestId('agent-list-column')).toBeInTheDocument()

    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
