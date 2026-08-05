// GroupChatPanel — the bounded render window (#71).
//
// The team view merges EVERY participant's transcript, each capped at 500
// entries, so a multi-agent room could hold thousands of markdown blocks and
// re-reconcile all of them on every streamed token. The timeline now renders
// only its tail, with a "Load earlier" control for the rest.
//
// The equivalent 1:1 coverage (including the author-grouping boundary case) is
// in `features/chat/__tests__/MessageList.window.test.tsx`; this file proves the
// window is wired into the merged team timeline, whose render path is the more
// complicated of the two.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'

import { RENDER_WINDOW_INITIAL } from '@/features/chat/chatComponents'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { FIRST_TASK_FLAG } from '@/lib/oneTimeFlag'
import { useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore, type Team } from '@/stores/team'

import { server } from '../../../__vitest__/mswServer'
import { GroupChatPanel } from '../GroupChatPanel'

const TEAM_SESSION_KEY = 'agent:a1:team:t1'

const TEAM: Team = {
  id: 't1',
  name: 'My First Team',
  icon: '🚀',
  color: '#e94560',
  colorCollectionId: null,
  templateId: null,
  agentCount: 1,
  leaderAgentId: 'a1',
  isArchived: false,
  serverOrchestrated: true,
}

function agent(id: string, name: string): AgentState {
  return {
    id,
    name,
    status: 'idle',
    sessionKey: `agent:${id}:native`,
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 't1',
    execConfig: null,
  }
}

function userEntry(i: number): TranscriptEntry {
  return {
    entryId: `u${i}`,
    role: 'user',
    kind: 'user',
    text: `msg-${i}`,
    sessionKey: TEAM_SESSION_KEY,
    runId: null,
    source: 'local-send',
    timestampMs: 1_700_000_000_000 + i,
    sequenceKey: i,
    confirmed: true,
    fingerprint: `f${i}`,
  }
}

function seedTeam(entryCount: number): void {
  // Opt out of the one-time guided-first-task prefill.
  localStorage.setItem(FIRST_TASK_FLAG, '1')
  useTeamStore.setState({ teams: [TEAM], selectedTeamId: 't1' })
  useFleetStore.setState({ agents: [agent('a1', 'Team Lead')], selectedAgentId: null })
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useBooZeroStore.setState({ booZeroAgentId: null })
  useChatStore.setState({
    transcripts: new Map([
      [TEAM_SESSION_KEY, Array.from({ length: entryCount }, (_, i) => userEntry(i))],
    ]),
    streamingText: new Map(),
    streamStartedAt: new Map(),
    lastTokenUsage: new Map(),
  })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useChatStore.setState({
    transcripts: new Map(),
    streamingText: new Map(),
    streamStartedAt: new Map(),
    lastTokenUsage: new Map(),
  })
})

describe('GroupChatPanel — bounded render window', () => {
  it('renders only the tail of a long team timeline, and reveals the rest on demand', async () => {
    server.use(
      // The panel hydrates history on mount; the store is already seeded, so the
      // per-participant fetch short-circuits — but MSW fails unhandled requests,
      // so both routes still need a handler.
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    const total = RENDER_WINDOW_INITIAL + 20
    seedTeam(total)

    render(
      <ThemeProvider>
        <GroupChatPanel teamId="t1" embedded />
      </ThemeProvider>,
    )

    // Newest rendered, oldest windowed out.
    expect(await screen.findByText(`msg-${total - 1}`)).toBeInTheDocument()
    expect(screen.getByText('msg-20')).toBeInTheDocument()
    expect(screen.queryByText('msg-0')).toBeNull()
    expect(screen.queryByText('msg-19')).toBeNull()
    expect(screen.getByTestId('load-earlier')).toHaveAttribute(
      'aria-label',
      'Load earlier messages (20 hidden)',
    )

    await userEvent.click(screen.getByTestId('load-earlier'))

    expect(screen.getByText('msg-0')).toBeInTheDocument()
    expect(screen.queryByTestId('load-earlier')).toBeNull()
  })

  it('leaves a short team timeline whole, with no affordance', async () => {
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    seedTeam(5)

    render(
      <ThemeProvider>
        <GroupChatPanel teamId="t1" embedded />
      </ThemeProvider>,
    )

    expect(await screen.findByText('msg-0')).toBeInTheDocument()
    expect(screen.queryByTestId('load-earlier')).toBeNull()
  })
})
