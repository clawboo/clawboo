// The 1:1 chat on a Claude Code, Codex or Hermes agent's page. These agents run on
// the server, not in the OpenClaw Gateway, so their message box must work with no
// Gateway at all (it used to read "Gateway not connected…") and must never hand a
// message to the Gateway when one is connected (the Gateway does not run them).

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { server } from '@/__vitest__/mswServer'

import { ChatPanel } from '../ChatPanel'

const RUNTIMES = ['claude-code', 'codex', 'hermes'] as const

function codingAgent(runtime: string): AgentState {
  return {
    id: 'a1',
    name: 'Coder Boo',
    status: 'idle',
    sessionKey: `agent:a1:${runtime}`,
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 't1',
    runtime,
    execConfig: null,
  }
}

function seed(runtime: string, client: GatewayClient | null): void {
  useFleetStore.setState({ agents: [codingAgent(runtime)], selectedAgentId: 'a1' })
  useConnectionStore.setState({
    status: 'connected',
    client,
    gatewayUrl: client ? 'ws://localhost:18789' : null,
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

let posted: Array<{ agentId: string; body: unknown }>

beforeEach(() => {
  posted = []
  server.use(
    http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
    http.post('/api/agents/:agentId/chat', async ({ params, request }) => {
      posted.push({ agentId: String(params['agentId']), body: await request.json() })
      return HttpResponse.json({ ok: true }, { status: 202 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})

describe.each(RUNTIMES)('ChatPanel: a %s agent chats through the server', (runtime) => {
  it('offers a live message box with no Gateway connected', () => {
    seed(runtime, null)
    renderPanel()
    expect(screen.getByTestId('chat-composer-input')).not.toBeDisabled()
    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Gateway not connected…')).toBeNull()
  })

  it('sends to the server even while a Gateway is connected', async () => {
    const send = vi.fn()
    seed(runtime, { chat: { send }, call: vi.fn() } as unknown as GatewayClient)
    renderPanel()
    const input = screen.getByTestId('chat-composer-input')
    fireEvent.change(input, { target: { value: 'hello there' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ agentId: 'a1', body: { message: 'hello there' } })
    expect(send).not.toHaveBeenCalled()
    // The optimistic bubble lands in the chat the page is showing.
    const shown = useChatStore.getState().transcripts.get(`agent:a1:${runtime}`) ?? []
    expect(shown.map((e) => e.text)).toEqual(['hello there'])
  })
})

class FakeEventSource {
  static last: FakeEventSource | null = null
  readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>()
  constructor(readonly url: string) {
    FakeEventSource.last = this
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  close(): void {}
  emit(type: string, data = ''): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent)
  }
}

describe('ChatPanel: a long server-run turn keeps the composer on Stop', () => {
  it('stays busy past the activity grace until the turn reports it is over', () => {
    // Hermes answers in one piece at the very end, so nothing streams for the whole
    // run. Only the turn's own status frames can keep the box closed that long.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.stubGlobal('EventSource', FakeEventSource)
    seed('hermes', null)
    renderPanel()
    const es = FakeEventSource.last!
    expect(es.url).toContain('/api/agents/a1/chat/stream')

    act(() => {
      es.emit('open')
      es.emit('status', JSON.stringify({ agentId: 'a1', status: 'running' }))
    })
    expect(screen.getByTestId('chat-stop-button')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByTestId('chat-stop-button')).toBeInTheDocument()

    act(() => {
      es.emit('status', JSON.stringify({ agentId: 'a1', status: 'idle' }))
    })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.queryByTestId('chat-stop-button')).toBeNull()
    expect(screen.getByTestId('chat-send-button')).toBeInTheDocument()
  })
})
