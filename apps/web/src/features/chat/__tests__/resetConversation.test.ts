// Starting fresh must not destroy the conversation, and must not move the chat.
//
// Both halves used to be broken in opposite directions: the native path deleted
// every stored message, and the Gateway path asked for a brand new session key and
// moved the chat onto it, stranding the old conversation under a key nothing points
// at any more. These pin the behaviour that replaced both.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatStore } from '@/stores/chat'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'

import { sendChatMessage } from '../chatSendOperation'

const SESSION = 'agent:a1:main'

type Call = { url: string; method: string }
let calls: Call[] = []

function agent(): AgentState {
  return {
    id: 'a1',
    name: 'Test Boo',
    status: 'idle',
    sessionKey: SESSION,
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: null,
    runtime: 'openclaw',
    execConfig: null,
  }
}

/** A client that records every RPC and succeeds. */
function makeClient(failSend = false) {
  const rpc: { method: string; params: unknown }[] = []
  return {
    rpc,
    client: {
      call: vi.fn(async (method: string, params: unknown) => {
        rpc.push({ method, params })
        if (failSend && method === 'chat.send') throw new Error('socket down')
        return {}
      }),
    } as never,
  }
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  useFleetStore.setState({ agents: [agent()], selectedAgentId: 'a1' })
  useChatStore.setState({ transcripts: new Map(), streamingText: new Map() })
  useConnectionStore.setState({ gatewayUrl: 'ws://localhost:18789' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const texts = (sessionKey: string) =>
  (useChatStore.getState().transcripts.get(sessionKey) ?? []).map((e) => e.text)

describe.each(['/reset', '/new'])('%s', (command) => {
  it('archives instead of deleting', async () => {
    const { client } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })

    const archive = calls.find((c) => c.url.includes('/api/chat-history/archive'))
    expect(archive?.method).toBe('POST')
    expect(archive?.url).toContain(encodeURIComponent(SESSION))
    // The destructive route must not be anywhere near this path.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('leaves the chat on the key it was already on', async () => {
    const { client, rpc } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })

    // No new key is minted, so nothing can be stranded under an old one.
    expect(rpc.some((c) => c.method === 'sessions.create')).toBe(false)
    expect(useFleetStore.getState().agents[0]?.sessionKey).toBe(SESSION)
  })

  it('tells the runtime, so the model forgets too', async () => {
    // Clearing only our side leaves the model answering from turns the person
    // can no longer see, which reads as the agent ignoring the reset.
    const { client, rpc } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })

    const send = rpc.find((c) => c.method === 'chat.send')
    expect(send?.params).toMatchObject({ sessionKey: SESSION, message: command })
  })

  it('clears the transcript and says the conversation is saved', async () => {
    useChatStore.getState().appendTranscript(SESSION, [
      {
        entryId: 'old',
        runId: null,
        sessionKey: SESSION,
        kind: 'user',
        role: 'user',
        text: 'an earlier message',
        source: 'local-send',
        timestampMs: 1,
        sequenceKey: 1,
        confirmed: true,
        fingerprint: 'old',
      },
    ])
    const { client } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })

    expect(texts(SESSION)).not.toContain('an earlier message')
    expect(texts(SESSION).join(' ')).toContain('saved')
  })

  it('never sends the command itself as a visible message', async () => {
    const { client } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })
    expect(texts(SESSION)).not.toContain(command)
    // ...and never persists one either.
    const posts = calls.filter(
      (c) => c.method === 'POST' && !c.url.includes('/archive') && c.url.includes('chat-history'),
    )
    expect(posts).toHaveLength(0)
  })

  it('warns when the runtime could not be reached', async () => {
    // The desk is clear but the model is not, and the difference shows the moment
    // it answers from something the person cannot see.
    const { client } = makeClient(true)
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })
    expect(texts(SESSION).join(' ')).toContain('may still remember')
  })
})
