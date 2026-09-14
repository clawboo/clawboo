// Seeing what a Boo does when nobody asked it to.
//
// Three properties carry this feature, and each has a failure mode that looks
// like success:
//
//  1. IT RE-SUBSCRIBES. A Gateway subscription dies with its socket and raises no
//     error on either side, so a watcher that subscribes once is correct on day
//     one and silently deaf after the first reconnect. There is nothing to see in
//     a log; the feed just stops filling.
//  2. IT DOES NOT DOUBLE-LOG. Committed transcript rows include the rows of runs
//     clawboo started and already logged off the live stream. A duplicate is not
//     cosmetic here: the feed is what an operator reads to know what an agent did,
//     and a doubled command reads as the agent having run it twice.
//  3. IT FAILS CLOSED ON IDENTITY. A row it cannot attribute must be dropped, not
//     guessed at. Every route that guessed which agent was calling was rejected
//     for this reason.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetLoggedToolCalls, markToolCallLogged } from '../loggedToolCalls'

const emitted: { kind: string; agentId?: string; data?: Record<string, unknown> }[] = []

vi.mock('../../obs/emit', () => ({
  emitEvent: (
    _db: unknown,
    input: { kind: string; agentId?: string; data?: Record<string, unknown> },
  ) => {
    emitted.push(input)
  },
}))
vi.mock('../../db', () => ({ getDb: () => ({}) }))

const { startSessionActivityWatcher } = await import('../sessionActivityWatcher')

/** A Gateway source under test control. */
function makeSource() {
  const calls: { method: string; params?: unknown }[] = []
  let onFrame: ((f: { event: string; payload?: unknown }) => void) | null = null
  let onConn: ((c: string) => void) | null = null
  return {
    calls,
    frame: (f: { event: string; payload?: unknown }) => onFrame?.(f),
    connect: (c = 'connected') => onConn?.(c),
    source: {
      operatorCall: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params })
        return undefined as T
      },
      onGatewayBroadcast: (cb: (f: { event: string; payload?: unknown }) => void) => {
        onFrame = cb
        return () => {
          onFrame = null
        }
      },
      onConnectionChange: (cb: (c: string) => void) => {
        onConn = cb
        return () => {
          onConn = null
        }
      },
    },
  }
}

/** A committed transcript row carrying one tool call, as `session.message` sends it. */
function messageFrame(sessionKey: string, toolCallId: string) {
  return {
    event: 'session.message',
    payload: {
      sessionKey,
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: toolCallId, name: 'exec', arguments: { command: 'ls -la' } },
        ],
      },
    },
  }
}

beforeEach(() => {
  emitted.length = 0
  resetLoggedToolCalls()
})

describe('startSessionActivityWatcher', () => {
  it('subscribes on connect, and AGAIN on every reconnect', async () => {
    // The silent-death failure. One subscribe at boot passes any test that only
    // connects once, and is deaf forever after the first dropped socket.
    const h = makeSource()
    startSessionActivityWatcher(h.source, () => 'a1')
    expect(h.calls).toHaveLength(0) // nothing before the connection is up

    h.connect()
    await Promise.resolve()
    h.connect('disconnected')
    h.connect('connected')
    await Promise.resolve()

    const subs = h.calls.filter((c) => c.method === 'sessions.subscribe')
    expect(subs).toHaveLength(2)
    // No agentId, unlike sessions.messages.subscribe, which refuses a bare key.
    expect(subs[0]?.params).toEqual({})
  })

  it('logs a tool call from a run clawboo never started', async () => {
    const h = makeSource()
    startSessionActivityWatcher(h.source, () => 'a1')
    h.connect()
    h.frame(messageFrame('agent:doc-writer-boo:main', 'call-1'))

    const calls = emitted.filter((e) => e.kind === 'tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.agentId).toBe('a1')
    expect(calls[0]?.data?.['name']).toBe('exec')
    // The whole reason this channel was chosen over the audit ledger: arguments survive.
    expect(calls[0]?.data?.['input']).toEqual({ command: 'ls -la' })
  })

  it('does NOT log a call the runner already logged', () => {
    // The duplicate. clawboo's own runs commit transcript rows too, so both
    // writers see them; the runner claims the id first because it is on the live
    // stream. Without this every ordinary tool call appears twice.
    const h = makeSource()
    startSessionActivityWatcher(h.source, () => 'a1')
    h.connect()

    markToolCallLogged('call-already-seen') // stand-in for executorRunner
    h.frame(messageFrame('agent:doc-writer-boo:main', 'call-already-seen'))

    expect(emitted.filter((e) => e.kind === 'tool_call')).toHaveLength(0)
  })

  it('does not log the same frame twice if it is redelivered', () => {
    const h = makeSource()
    startSessionActivityWatcher(h.source, () => 'a1')
    h.connect()
    h.frame(messageFrame('agent:doc-writer-boo:main', 'call-2'))
    h.frame(messageFrame('agent:doc-writer-boo:main', 'call-2'))
    expect(emitted.filter((e) => e.kind === 'tool_call')).toHaveLength(1)
  })

  it('DROPS a row it cannot attribute rather than guessing', () => {
    // Fails closed. A row filed against the wrong agent is worse than a missing
    // row, because the feed is what an operator trusts about what an agent did.
    const h = makeSource()
    startSessionActivityWatcher(h.source, () => null) // no such agent
    h.connect()
    h.frame(messageFrame('agent:ghost-boo:main', 'call-3'))
    expect(emitted).toHaveLength(0)
  })

  it('ignores a session key it cannot parse', () => {
    const h = makeSource()
    const resolve = vi.fn(() => 'a1')
    startSessionActivityWatcher(h.source, resolve)
    h.connect()
    h.frame(messageFrame('not-a-session-key', 'call-4'))
    expect(emitted).toHaveLength(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('files a row under the clawboo ROW id, not the OpenClaw agent id', () => {
    // These are equal on every row today, so a naive implementation passes every
    // test that can be written now and misattributes the first time an agent is
    // renamed or re-imported under a different id.
    const h = makeSource()
    startSessionActivityWatcher(h.source, (sourceId) =>
      sourceId === 'doc-writer-boo' ? 'clawboo-row-99' : null,
    )
    h.connect()
    h.frame(messageFrame('agent:doc-writer-boo:main', 'call-5'))
    expect(emitted[0]?.agentId).toBe('clawboo-row-99')
  })

  it('stops listening after stop()', () => {
    const h = makeSource()
    const w = startSessionActivityWatcher(h.source, () => 'a1')
    h.connect()
    w.stop()
    h.frame(messageFrame('agent:doc-writer-boo:main', 'call-6'))
    expect(emitted).toHaveLength(0)
  })
})
