// An agent's page at phone width is its chat. The side cards (graph, tasks,
// browser, activity, details) cannot sit beside a chat that needs 360 px, so
// each opens over the whole screen from its toggle, and its close or restore
// button goes back to the chat. None of that writes the cards' saved open state,
// which belongs to the same browser's wide layout.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockPhoneViewport, type PhoneViewport } from '@/__vitest__/phoneViewport'
import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'
import { usePanelLayoutStore } from '@/stores/panelLayout'

import { AgentDetailView } from '../AgentDetailView'

vi.mock('@/features/chat/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}))
vi.mock('@/features/obs/ActivityTerminal', () => ({
  ActivityTerminal: () => <div data-testid="activity-feed" />,
}))
vi.mock('@/components/AgentBooAvatar', () => ({ AgentBooAvatar: () => null }))
vi.mock('@/features/promo/GitHubStarButton', () => ({ GitHubStarButton: () => null }))

const AGENT: AgentState = {
  id: 'a1',
  name: 'Ada',
  status: 'idle',
  sessionKey: 'agent:a1:main',
  model: null,
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: null,
  execConfig: null,
}

let viewport: PhoneViewport

beforeEach(() => {
  useFleetStore.setState({ agents: [AGENT] })
  // A fresh install's defaults: the graph and details cards open.
  usePanelLayoutStore.setState({ panes: {} })
})
afterEach(() => {
  cleanup()
  viewport.restore()
})

describe('AgentDetailView at phone width', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(true)
  })

  it('shows the chat alone, with no side cards and no resize handle', () => {
    render(<AgentDetailView agentId="a1" />)
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-card-graph')).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-card-files')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    // Nothing is open over the chat, so no toggle reads as pressed.
    expect(screen.getByTestId('pane-toggle-graph')).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens a card over the whole screen, and its close goes back to the chat', async () => {
    render(<AgentDetailView agentId="a1" />)
    await userEvent.click(screen.getByTestId('pane-toggle-activity'))
    expect(screen.getByTestId('agent-card-activity')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close activity' }))
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-card-activity')).not.toBeInTheDocument()
  })

  it('goes back to the chat from the restore button too', async () => {
    render(<AgentDetailView agentId="a1" />)
    await userEvent.click(screen.getByTestId('pane-toggle-activity'))
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
  })

  it("leaves the wide layout's saved cards alone", async () => {
    render(<AgentDetailView agentId="a1" />)
    await userEvent.click(screen.getByTestId('pane-toggle-activity'))
    await userEvent.click(screen.getByRole('button', { name: 'Close activity' }))
    expect(usePanelLayoutStore.getState().panes).toEqual({})
  })
})

describe('AgentDetailView on a wide window', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(false)
  })

  it('keeps an open card beside the chat', () => {
    usePanelLayoutStore.setState({
      panes: { 'agent:graph': false, 'agent:files': false, 'agent:activity': true },
    })
    render(<AgentDetailView agentId="a1" />)
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('agent-card-activity')).toBeInTheDocument()
    expect(screen.getByTestId('pane-toggle-activity')).toHaveAttribute('aria-pressed', 'true')
  })
})
