// GroupChatPanel's polite live region. Incoming agent replies were entirely
// silent to a screen reader; these pin the announce rules AND — most
// importantly — that an in-flight stream never reaches the region. Marking the
// message list itself aria-live would re-read a growing sentence on every SSE
// token; that regression is what the third test here catches.

import { act } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'

import type { AgentState } from '@/stores/fleet'
import { useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore, type Team } from '@/stores/team'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { FIRST_TASK_FLAG } from '@/lib/oneTimeFlag'
import { buildTeamSessionKey } from '@/lib/sessionUtils'

import { server } from '../../../__vitest__/mswServer'
import { GroupChatPanel } from '../GroupChatPanel'

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

const TEAM: Team = {
  id: 't1',
  name: 'My First Team',
  icon: '🚀',
  color: '#e94560',
  colorCollectionId: null,
  templateId: null,
  agentCount: 2,
  leaderAgentId: 'a1',
  isArchived: false,
  serverOrchestrated: true,
}

const CODER_KEY = buildTeamSessionKey('a2', 't1')

function seedNativeTeam(): void {
  localStorage.setItem(FIRST_TASK_FLAG, '1')
  useTeamStore.setState({ teams: [TEAM], selectedTeamId: 't1' })
  useFleetStore.setState({
    agents: [agent('a1', 'Team Lead'), agent('a2', 'Coder')],
    selectedAgentId: null,
  })
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useBooZeroStore.setState({ booZeroAgentId: null })
}

function committed(text: string, timestampMs: number, entryId = 'e1'): TranscriptEntry {
  return {
    entryId,
    role: 'assistant',
    kind: 'assistant',
    text,
    sessionKey: CODER_KEY,
    runId: null,
    source: 'runtime-chat',
    timestampMs,
    sequenceKey: timestampMs,
    confirmed: true,
    fingerprint: entryId,
  }
}

function renderPanel() {
  return render(
    <ThemeProvider>
      <GroupChatPanel teamId="t1" embedded />
    </ThemeProvider>,
  )
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useChatStore.setState({ transcripts: new Map() })
})

describe('GroupChatPanel live region', () => {
  it('stays silent for history backfilled on mount', async () => {
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    seedNativeTeam()
    // A turn that predates the panel opening — a backfill, not an arrival.
    useChatStore.getState().appendTranscript(CODER_KEY, [committed('Old news', 1)])

    renderPanel()
    await screen.findByTestId('group-chat-panel')
    expect(screen.getByTestId('group-chat-announcer')).toBeEmptyDOMElement()
  })

  it('announces a committed reply that lands after the panel opened', async () => {
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    seedNativeTeam()
    renderPanel()
    await screen.findByTestId('group-chat-panel')

    act(() => {
      useChatStore
        .getState()
        .appendTranscript(CODER_KEY, [committed('Shipped the tagline.', Date.now() + 1000)])
    })

    await waitFor(() =>
      expect(screen.getByTestId('group-chat-announcer')).toHaveTextContent(
        'Coder said: Shipped the tagline.',
      ),
    )
  })

  // THE firehose guard: a live stream mutates on every token. If the region ever
  // read from the render list instead of committed blocks, this would speak
  // "Th", "Thin", "Thinki"… on every delta.
  it('never announces in-flight streaming text', async () => {
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    seedNativeTeam()
    renderPanel()
    await screen.findByTestId('group-chat-panel')

    for (const chunk of ['Wri', 'Writi', 'Writing the', 'Writing the tagline']) {
      act(() => useChatStore.getState().setStreamingText(CODER_KEY, chunk))
    }

    await waitFor(() => expect(screen.getByTestId('group-chat-announcer')).toBeInTheDocument())
    expect(screen.getByTestId('group-chat-announcer')).toBeEmptyDOMElement()
  })

  it('stays silent on a delegate-only turn', async () => {
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    seedNativeTeam()
    renderPanel()
    await screen.findByTestId('group-chat-panel')

    act(() => {
      useChatStore
        .getState()
        .appendTranscript(CODER_KEY, [
          committed('<delegate to="Coder">write it</delegate>', Date.now() + 1000),
        ])
    })

    await waitFor(() => expect(screen.getByTestId('group-chat-announcer')).toBeInTheDocument())
    expect(screen.getByTestId('group-chat-announcer')).toBeEmptyDOMElement()
  })
})
