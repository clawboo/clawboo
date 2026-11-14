// The agent page's tab that shows the agent's files is "Computer". "Workspace"
// names a whole Clawboo (Settings > Workspace), so the agent tab must not use it.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'

import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'

import { InlineEditor } from '../InlineEditor'

vi.mock('@/features/editor/useAgentFiles', () => ({
  ALL_FILE_TABS: [],
  useAgentFiles: () => ({
    files: {},
    loading: false,
    saving: false,
    isDirty: () => false,
    anyDirty: false,
    fileExists: () => false,
    handleSave: vi.fn(),
    saveAllDirty: vi.fn(),
    updateFileContent: vi.fn(),
  }),
}))
vi.mock('@/features/workspace/WorkspacePanel', () => ({
  WorkspacePanel: ({ agentId }: { agentId: string }) => (
    <div data-testid="computer-panel">{agentId}</div>
  ),
}))
vi.mock('@/features/settings/PersonalitySliders', () => ({
  PersonalitySliders: () => <div data-testid="personality" />,
}))

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
  runtime: 'claude-code',
}

beforeEach(() => {
  useFleetStore.setState({ agents: [AGENT] })
})
afterEach(() => cleanup())

const renderEditor = () =>
  render(
    <ThemeProvider>
      <InlineEditor agentId="a1" agentName="Ada" />
    </ThemeProvider>,
  )

describe('InlineEditor Computer tab', () => {
  it('names the agent files tab Computer, never Workspace', () => {
    renderEditor()

    const strip = screen.getByRole('tablist', { name: 'Agent details' })
    const labels = [...strip.querySelectorAll('[role="tab"]')].map((t) => t.textContent)
    expect(labels).toContain('Computer')
    expect(labels).not.toContain('Workspace')
  })

  it('opens the agent computer view with a footer that says Computer', () => {
    renderEditor()

    fireEvent.click(screen.getByRole('tab', { name: 'Computer' }))
    expect(screen.getByTestId('computer-panel').textContent).toBe('a1')
    expect(screen.getByText('Ada · Computer · read-only')).toBeTruthy()
    expect(screen.queryByText(/Workspace/)).toBeNull()
  })
})
