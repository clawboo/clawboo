// Boo Zero's own chat. On a runtime the server runs, its hand-offs are real: an @Team
// goes to the server with the message, the work shows as the team chat's card, and the
// reply carries no "not handed off" note. On OpenClaw the chat runs in the Gateway, and
// the server only forwards its replies, unread: no team work starts, the rules say
// hand-offs are off, and a tag in the reply shows as the note.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'
import type { TranscriptEntry } from '@clawboo/protocol'

import { useBooZeroStore } from '@/stores/booZero'
import { useChatHandOffStore } from '@/stores/chatHandOffs'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { server } from '@/__vitest__/mswServer'

import { ChatPanel } from '../ChatPanel'

const TEAM = {
  id: 'team-1',
  name: 'Growth',
  icon: '🚀',
  color: '#000',
  isArchived: false,
} as never

function booZero(runtime: string, sessionKey: string): AgentState {
  return {
    id: 'bz',
    name: 'Boo Zero',
    status: 'idle',
    sessionKey,
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    runtime,
    execConfig: null,
    providerReady: true,
  }
}

function reply(sessionKey: string, text: string, at: number): TranscriptEntry {
  return {
    entryId: `e-${at}`,
    role: 'assistant',
    kind: 'assistant',
    text,
    sessionKey,
    runId: null,
    source: 'runtime-agent',
    timestampMs: at,
    sequenceKey: at,
    confirmed: true,
    fingerprint: `e-${at}`,
  } as TranscriptEntry
}

function seed(
  runtime: string,
  sessionKey: string,
  client: GatewayClient | null,
  serverSaysOn = true,
): void {
  useFleetStore.setState({ agents: [booZero(runtime, sessionKey)], selectedAgentId: 'bz' })
  useConnectionStore.setState({
    status: 'connected',
    client,
    gatewayUrl: client ? 'ws://localhost:18789' : null,
  })
  useChatStore.setState({ transcripts: new Map(), streamingText: new Map() })
  useBooZeroStore.setState({ booZeroAgentId: 'bz' })
  useTeamStore.setState({ teams: [TEAM], selectedTeamId: null })
  useChatHandOffStore.setState({
    tasksByAgent: new Map(),
    handsOffByAgent: new Map(serverSaysOn ? [['bz', true]] : []),
  })
}

function card(status = 'in_progress', updatedAt = 2_000): void {
  useChatHandOffStore.getState().applyFrame('bz', {
    id: 'task-1',
    identifier: 'GRO-1',
    title: 'fix the parser',
    status,
    teamId: 'team-1',
    createdAt: 1_500,
    updatedAt,
  })
}

const renderPanel = () =>
  render(
    <ThemeProvider>
      <ChatPanel agentId="bz" />
    </ThemeProvider>,
  )

let posted: Array<Record<string, unknown>>

beforeEach(() => {
  posted = []
  server.use(
    http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
    http.post('/api/chat-history', () => HttpResponse.json({ ok: true })),
    http.get('/api/board/:taskId', () => HttpResponse.json({ task: {}, comments: [] })),
    http.get('/api/teams/:id/activity-summary', () => HttpResponse.json({ content: 'recent' })),
    http.post('/api/agents/:agentId/chat', async ({ request }) => {
      posted.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({ ok: true }, { status: 202 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
  useBooZeroStore.setState({ booZeroAgentId: null })
})

describe.each(['clawboo-native', 'claude-code', 'codex', 'hermes'])(
  'a Boo Zero on %s: hand-offs are real',
  (runtime) => {
    const key = runtime === 'clawboo-native' ? 'agent:bz:native' : `agent:bz:${runtime}`

    it('shows the team chat card for the work, under the team it went to', () => {
      seed(runtime, key, null)
      card()
      renderPanel()
      expect(screen.getByTestId('board-task-card')).toBeInTheDocument()
      expect(screen.getByTestId('board-task-id')).toHaveTextContent('GRO-1')
      expect(screen.getByTestId('chat-hand-off')).toHaveTextContent('Handed to Growth')
      expect(screen.getByText('fix the parser')).toBeInTheDocument()
    })

    it('shows no note for a tag in a reply, and no empty bubble for a reply that is only one', () => {
      seed(runtime, key, null)
      useChatStore
        .getState()
        .appendTranscript(key, [
          reply(key, '<delegate to="@Growth/Coder">fix the parser</delegate>', 1_000),
        ])
      card()
      renderPanel()
      expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
      expect(screen.queryByText(/~\d+ tokens/)).toBeNull()
      expect(screen.getByTestId('board-task-card')).toBeInTheDocument()
    })

    it('shows the words around a tag, with no note', () => {
      seed(runtime, key, null)
      useChatStore
        .getState()
        .appendTranscript(key, [
          reply(key, 'On it. <delegate to="@Growth/Coder">fix the parser</delegate>', 1_000),
        ])
      renderPanel()
      expect(screen.getByText('On it.')).toBeInTheDocument()
      expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    })

    it('a card moves as its frames arrive', () => {
      seed(runtime, key, null)
      card()
      renderPanel()
      expect(screen.getByTestId('board-task-card')).toHaveAttribute(
        'data-task-status',
        'in_progress',
      )
      act(() => card('done', 3_000))
      expect(screen.getByTestId('board-task-card')).toHaveAttribute('data-task-status', 'done')
    })

    it('a card a person cancelled leaves the chat, as in a team chat', () => {
      seed(runtime, key, null)
      card()
      renderPanel()
      act(() => card('cancelled', 3_000))
      expect(screen.queryByTestId('board-task-card')).toBeNull()
    })

    it('tells the server which team an @Team names, and the rules say it can hand off', async () => {
      seed(runtime, key, null)
      renderPanel()
      const input = screen.getByTestId('chat-composer-input')
      fireEvent.change(input, { target: { value: '@Growth fix the parser' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(posted).toHaveLength(1))
      expect(posted[0]!['teamId']).toBe('team-1')
      expect(posted[0]!['displayText']).toBe('@Growth fix the parser')
      expect(posted[0]!['message']).toContain('You can hand work to a team from here')
      expect(posted[0]!['message']).not.toMatch(/hand-offs are off/i)
    })

    it('with no @Team, names no team', async () => {
      seed(runtime, key, null)
      renderPanel()
      const input = screen.getByTestId('chat-composer-input')
      fireEvent.change(input, { target: { value: 'fix the parser' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(posted).toHaveLength(1))
      expect(posted[0]).not.toHaveProperty('teamId')
    })
  },
)

describe('an OpenClaw Boo Zero: the honest exception', () => {
  const key = 'agent:bz:main'
  const gateway = (call: ReturnType<typeof vi.fn>) => ({ call }) as unknown as GatewayClient

  it('sends to the Gateway with rules that say hand-offs are off, and nothing to the server', async () => {
    const call = vi.fn().mockResolvedValue({ runId: 'r1' })
    seed('openclaw', key, gateway(call), false)
    renderPanel()
    const input = screen.getByTestId('chat-composer-input')
    fireEvent.change(input, { target: { value: '@Growth fix the parser' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(call).toHaveBeenCalledWith('chat.send', expect.anything()))
    const sent = JSON.stringify(call.mock.calls.find((c) => c[0] === 'chat.send'))
    expect(sent).toMatch(/hand-offs are off here/i)
    expect(posted).toEqual([])
  })

  it('shows a tag in a reply as the note, and shows no card', () => {
    seed('openclaw', key, gateway(vi.fn()), false)
    useChatStore
      .getState()
      .appendTranscript(key, [
        reply(key, 'On it. <delegate to="@Coder">fix the parser</delegate>', 1_000),
      ])
    // Even if a card somehow reached the store, this chat started no work to show.
    card()
    renderPanel()
    expect(screen.getByTestId('not-handed-off-note')).toHaveTextContent('Not handed off')
    expect(screen.queryByTestId('board-task-card')).toBeNull()
    expect(screen.queryByTestId('chat-hand-off')).toBeNull()
  })
})

describe("another agent's one-to-one chat", () => {
  it('keeps the note: nothing there acts on a tag', () => {
    seed('codex', 'agent:bz:codex', null, false)
    useBooZeroStore.setState({ booZeroAgentId: 'someone-else' })
    useChatStore
      .getState()
      .appendTranscript('agent:bz:codex', [
        reply('agent:bz:codex', '<delegate to="@Coder">x</delegate>', 1_000),
      ])
    renderPanel()
    expect(screen.getByTestId('not-handed-off-note')).toBeInTheDocument()
  })
})

describe('when the browser and the server disagree about who Boo Zero is', () => {
  const key = 'agent:bz:codex'

  it('the browser thinks so and the server does not: nothing hides, and the rules say off', async () => {
    seed('codex', key, null, false)
    useChatStore
      .getState()
      .appendTranscript(key, [reply(key, 'On it. <delegate to="@Coder">fix it</delegate>', 1_000)])
    renderPanel()

    expect(screen.getByTestId('not-handed-off-note')).toBeInTheDocument()

    const input = screen.getByTestId('chat-composer-input')
    fireEvent.change(input, { target: { value: 'fix it' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!['message']).toMatch(/hand-offs are off here/i)
    expect(posted[0]!['message']).not.toContain('Hand-offs from this chat')
  })

  it('the server says so and the browser does not: an @Team still names the team', async () => {
    seed('codex', key, null, true)
    useBooZeroStore.setState({ booZeroAgentId: 'someone-else' })
    renderPanel()
    const input = screen.getByTestId('chat-composer-input')
    fireEvent.change(input, { target: { value: '@Growth fix the parser' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!['teamId']).toBe('team-1')
  })

  it('the server says so and the browser does not: the work shows, with no false note', () => {
    seed('codex', key, null, true)
    useBooZeroStore.setState({ booZeroAgentId: 'someone-else' })
    useChatStore
      .getState()
      .appendTranscript(key, [reply(key, 'On it. <delegate to="@Coder">fix it</delegate>', 1_000)])
    card()
    renderPanel()

    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    expect(screen.getByTestId('board-task-card')).toBeInTheDocument()
  })
})

describe('a tag this chat only shows', () => {
  const key = 'agent:bz:codex'
  const shown = 'What I would send:\n\n```\n<delegate to="@Growth/Coder">fix it</delegate>\n```'

  it('stays on screen, as written: an all-tag filter must not hide it', () => {
    seed('codex', key, null)
    useChatStore.getState().appendTranscript(key, [reply(key, shown, 1_000)])
    renderPanel()

    expect(screen.getByText(/What I would send/)).toBeInTheDocument()
    expect(screen.getByText(/delegate to=/)).toBeInTheDocument()
    expect(screen.queryByTestId('board-task-card')).toBeNull()
  })

  it('an all-tag reply in code is still shown, not taken for a hand-off', () => {
    seed('codex', key, null)
    useChatStore
      .getState()
      .appendTranscript(key, [
        reply(key, '```\n<delegate to="@Growth/Coder">fix it</delegate>\n```', 1_000),
      ])
    renderPanel()

    expect(screen.getByText(/delegate to=/)).toBeInTheDocument()
  })
})
