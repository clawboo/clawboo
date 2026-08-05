// Composer gating across a live Gateway drop. The two runtimes must diverge here:
// an OpenClaw chat rides the browser's Gateway socket, so a send cannot land while
// it is down; a native chat is driven server-side over SSE and is unaffected.
// Gating both (which a naive `status === 'connected'` check does) would disable a
// native composer for a reason that has nothing to do with it — and mixed fleets
// are real, since the Gateway hydrate merges non-OpenClaw agents in.

import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore, type ConnectionStatus } from '@/stores/connection'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { makeFakeGatewayClient } from '@/__vitest__/fakeGatewayClient'
import { server } from '@/__vitest__/mswServer'

import { ChatPanel } from '../ChatPanel'

function agent(runtime: AgentState['runtime']): AgentState {
  return {
    id: 'a1',
    name: 'Test Boo',
    status: 'idle',
    sessionKey: 'agent:a1:main',
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    runtime,
    execConfig: null,
  }
}

function seed(runtime: AgentState['runtime'], status: ConnectionStatus): void {
  useFleetStore.setState({ agents: [agent(runtime)], selectedAgentId: 'a1' })
  // A live client is present throughout: the drop is a SOCKET state, not a
  // missing client, so `!client` cannot be what gates the composer.
  useConnectionStore.setState({
    status,
    client: makeFakeGatewayClient(status === 'connected' ? 'connected' : 'reconnecting').client,
    gatewayUrl: 'ws://localhost:18789',
  })
  useChatStore.setState({ transcripts: new Map(), streamingText: new Map() })
  useBooZeroStore.setState({ booZeroAgentId: null })
  useTeamStore.setState({ teams: [], selectedTeamId: null })
}

function renderPanel() {
  return render(
    <ThemeProvider>
      <ChatPanel agentId="a1" />
    </ThemeProvider>,
  )
}

beforeEach(() => {
  server.use(http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })))
})

afterEach(() => {
  cleanup()
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})

describe('ChatPanel — OpenClaw composer follows the live socket', () => {
  it('is live while the socket is connected', () => {
    seed('openclaw', 'connected')
    renderPanel()
    expect(screen.getByTestId('chat-composer-input')).not.toBeDisabled()
  })

  it('gates off while the socket is reconnecting', () => {
    seed('openclaw', 'reconnecting')
    renderPanel()
    expect(screen.getByTestId('chat-composer-input')).toBeDisabled()
  })

  it('says WHY it is disabled instead of leaving a dead "Message…" box', () => {
    seed('openclaw', 'reconnecting')
    renderPanel()
    expect(screen.getByPlaceholderText('Reconnecting to Gateway…')).toBeInTheDocument()
  })

  it('reports the drop in the header indicator', () => {
    seed('openclaw', 'reconnecting')
    renderPanel()
    expect(screen.getByText('Reconnecting')).toBeInTheDocument()
  })
})

describe('ChatPanel — a native composer is unaffected by a Gateway drop', () => {
  it('stays live while the Gateway socket is reconnecting', () => {
    // Native runs server-side over SSE. Its send does not touch the Gateway, so
    // disabling it here would be a pure false negative.
    seed('clawboo-native', 'reconnecting')
    renderPanel()
    expect(screen.getByTestId('chat-composer-input')).not.toBeDisabled()
  })
})
