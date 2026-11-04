// A team's space at phone width is its group chat. The team graph and tasks
// cards a fresh install opens beside the chat would leave it a sliver, so at
// this width each card opens over the whole screen from its toggle instead, and
// its close goes back to the chat, without touching the cards' saved state.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockPhoneViewport, type PhoneViewport } from '@/__vitest__/phoneViewport'
import { usePanelLayoutStore } from '@/stores/panelLayout'

import { TeamSpaceSplit } from '../TeamSpaceSplit'

vi.mock('../GroupChatPanel', () => ({
  GroupChatPanel: () => <div data-testid="group-chat-panel" />,
}))
vi.mock('../GroupChatViewHeader', () => ({
  GroupChatViewHeader: ({ trailing }: { trailing?: ReactNode }) => <header>{trailing}</header>,
  TeamGraphCountPill: () => null,
}))
vi.mock('@/features/graph/GhostGraphPanel', () => ({
  GhostGraphPanel: () => <div data-testid="ghost-graph" />,
}))
vi.mock('../TeamBrowser', () => ({ TeamBrowser: () => <div data-testid="team-browser" /> }))
vi.mock('../TeamTasksCard', () => ({
  TeamTasksCard: () => <div data-testid="team-card-tasks" />,
}))
vi.mock('@/features/obs/ActivityTerminal', () => ({
  ActivityTerminal: () => <div data-testid="activity-feed" />,
}))

let viewport: PhoneViewport

const renderSplit = () =>
  render(<TeamSpaceSplit teamId="t1" roomId={null} team={null} animateOpen={false} />)

beforeEach(() => {
  // A fresh install's defaults: the graph and tasks cards open.
  usePanelLayoutStore.setState({ panes: {} })
})
afterEach(() => {
  cleanup()
  viewport.restore()
})

describe('TeamSpaceSplit at phone width', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(true)
  })

  it('shows the group chat alone', () => {
    renderSplit()
    expect(screen.getByTestId('group-chat-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('team-card-graph')).not.toBeInTheDocument()
    expect(screen.queryByTestId('team-card-tasks')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('opens a card over the whole screen, and its close goes back to the chat', async () => {
    renderSplit()
    await userEvent.click(screen.getByTestId('pane-toggle-team-graph'))
    expect(screen.getByTestId('team-card-graph')).toBeInTheDocument()
    expect(screen.queryByTestId('group-chat-panel')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close team graph' }))
    expect(screen.getByTestId('group-chat-panel')).toBeInTheDocument()
    expect(usePanelLayoutStore.getState().panes).toEqual({})
  })
})

describe('TeamSpaceSplit on a wide window', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(false)
  })

  it('keeps the default cards beside the chat', () => {
    renderSplit()
    expect(screen.getByTestId('group-chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('team-card-graph')).toBeInTheDocument()
    expect(screen.getByTestId('team-card-tasks')).toBeInTheDocument()
  })
})
