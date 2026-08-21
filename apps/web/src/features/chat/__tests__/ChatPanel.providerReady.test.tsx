// The per-agent "No provider key" badge.
//
// Runtime health is deliberately permissive: it reads green when ANY provider is
// connected. So an agent configured for a provider whose key is missing sits
// under a healthy runtime and cannot answer, which is the exact failure the
// per-agent `providerReady` flag exists to make visible. Without a render test
// the whole chain (server flag -> fleet store -> badge) can be severed with the
// suite still green, restoring a green header over an agent that cannot reply.
//
// The badge must NOT gate the composer: the flag only refreshes on a registry
// read, so gating on it would leave the composer dead after the user fixes the
// key, whereas a send that still fails reports its reason in the transcript.

import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { server } from '@/__vitest__/mswServer'

import { ChatPanel } from '../ChatPanel'

function nativeAgent(providerReady: boolean | null): AgentState {
  return {
    id: 'a1',
    name: 'Test Boo',
    status: 'idle',
    sessionKey: 'agent:a1:native',
    model: 'claude-haiku-4-5',
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    runtime: 'clawboo-native',
    execConfig: null,
    providerReady,
  }
}

function seed(providerReady: boolean | null): void {
  useFleetStore.setState({ agents: [nativeAgent(providerReady)], selectedAgentId: 'a1' })
  // Native mode: no Gateway client, and the app-shell status is irrelevant to a
  // native chat, which rides the server's SSE.
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: null })
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
  server.use(
    http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
    // The runtime itself is healthy: a DIFFERENT provider is connected, which is
    // precisely why the runtime-level signal cannot reveal this agent's problem.
    http.get('/api/runtimes', () =>
      HttpResponse.json({
        runtimes: [
          {
            id: 'clawboo-native',
            installed: true,
            connectionState: 'ready',
            health: { ok: true },
          },
        ],
      }),
    ),
  )
})

afterEach(() => {
  cleanup()
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})

describe('ChatPanel: the per-agent provider badge', () => {
  it('badges an agent whose own provider key is missing, under a HEALTHY runtime', async () => {
    seed(false)
    renderPanel()
    expect(await screen.findByText('No provider key')).toBeInTheDocument()
    // And offers the way to fix it.
    expect(await screen.findByTestId('native-disconnected-chip')).toBeInTheDocument()
  })

  it('does not badge an agent whose provider key resolves', async () => {
    seed(true)
    renderPanel()
    expect(screen.queryByText('No provider key')).toBeNull()
    expect(screen.queryByTestId('native-disconnected-chip')).toBeNull()
  })

  it('does not badge when readiness is unknown (a source that does not report it)', async () => {
    seed(null)
    renderPanel()
    expect(screen.queryByText('No provider key')).toBeNull()
  })

  it('badges without disabling the composer, so fixing the key is never a dead end', async () => {
    seed(false)
    renderPanel()
    expect(await screen.findByText('No provider key')).toBeInTheDocument()
    expect(screen.getByTestId('chat-composer-input')).not.toBeDisabled()
  })
})
