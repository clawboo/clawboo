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
import { isResetCommand } from '../resetConversation'

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
      const body = String(url).includes('/reset-context')
        ? {
            ok: true,
            entry: {
              entryId: 'divider-1',
              runId: null,
              sessionKey: SESSION,
              kind: 'meta',
              role: 'system',
              text: 'Starting fresh from here. Everything above stays for you to read, but your boo is no longer carrying it.',
              source: 'local-send',
              timestampMs: 99,
              sequenceKey: 99,
              confirmed: true,
              fingerprint: 'divider-1',
            },
          }
        : { ok: true }
      return new Response(JSON.stringify(body), {
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
  it('resets the context and never touches a message', async () => {
    const { client } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })

    expect(calls.some((c) => c.url.includes('/api/chat-history/reset-context'))).toBe(true)
    // Neither the destructive route nor the old archive route belongs on this path.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(calls.some((c) => c.url.includes('/archive'))).toBe(false)
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

  it('KEEPS every earlier message on screen and adds a divider', async () => {
    // The whole point: a person can still read what came before, in the same chat.
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

    expect(texts(SESSION)).toContain('an earlier message')
    expect(texts(SESSION).join(' ')).toContain('Starting fresh from here')
  })

  it('never sends the command itself as a visible message', async () => {
    const { client } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })
    expect(texts(SESSION)).not.toContain(command)
    // ...and never persists one as a message either. The only write on this path
    // is the context reset itself.
    const posts = calls.filter(
      (c) =>
        c.method === 'POST' && c.url.includes('chat-history') && !c.url.includes('/reset-context'),
    )
    expect(posts).toHaveLength(0)
  })

  it('warns when the runtime could not be reached', async () => {
    // Our side let go but the runtime did not, and the difference shows the moment
    // it answers from a thread the divider says it has released.
    const { client } = makeClient(true)
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: command })
    expect(texts(SESSION).join(' ')).toContain('may still be carrying')
  })
})

describe('isResetCommand', () => {
  it('accepts both names, in any case', () => {
    // A phone autocapitalises the first letter. Treating `/Reset` as an ordinary
    // message hands the boo a literal "/Reset" to interpret instead of clearing.
    for (const text of ['/reset', '/new', '/Reset', '/NEW', '  /Reset  ']) {
      expect(isResetCommand(text), text).toBe(true)
    }
  })

  it('does not fire on anything else', () => {
    for (const text of ['/resets', '/reset now', 'reset', '/newline', '', '/rule /reset']) {
      expect(isResetCommand(text), text).toBe(false)
    }
  })
})

describe('a failed reset', () => {
  it('says so instead of drawing a divider the boo did not honour', async () => {
    // Nothing was reset, so the boo is still carrying the conversation. A divider
    // here would be the one thing that is not true.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    const { client } = makeClient()
    await sendChatMessage({ client, agentId: 'a1', sessionKey: SESSION, message: '/reset' })

    const said = texts(SESSION).join(' ')
    expect(said).not.toContain('Starting fresh from here')
    expect(said).toContain('Could not start fresh')
  })
})
