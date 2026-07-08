// chatDeltaBus — the in-memory per-team live-token pub/sub (the SSE Tier-2 channel).
// Asserts: delivery to current subscribers, unsubscribe stops delivery, per-team
// isolation, a publish with no subscribers is a harmless no-op, and a throwing
// listener can't break sibling listeners (so a dead SSE write never kills the drain).

import { describe, expect, it } from 'vitest'

import { publishChatDelta, subscribeChatDelta, type ChatDelta } from '../chatDeltaBus'

const delta = (sessionKey: string, text: string): ChatDelta => ({ sessionKey, runId: 'r1', text })

describe('chatDeltaBus', () => {
  it('delivers a published delta to a current subscriber', () => {
    const seen: ChatDelta[] = []
    const unsub = subscribeChatDelta('T', (d) => seen.push(d))
    publishChatDelta('T', delta('agent:a1:team:T', 'hi'))
    expect(seen).toEqual([{ sessionKey: 'agent:a1:team:T', runId: 'r1', text: 'hi' }])
    unsub()
  })

  it('stops delivering after unsubscribe', () => {
    const seen: ChatDelta[] = []
    const unsub = subscribeChatDelta('T', (d) => seen.push(d))
    publishChatDelta('T', delta('agent:a1:team:T', 'one'))
    unsub()
    publishChatDelta('T', delta('agent:a1:team:T', 'two'))
    expect(seen.map((d) => d.text)).toEqual(['one'])
  })

  it('is isolated per team — team A publish never reaches a team B subscriber', () => {
    const a: ChatDelta[] = []
    const b: ChatDelta[] = []
    const ua = subscribeChatDelta('A', (d) => a.push(d))
    const ub = subscribeChatDelta('B', (d) => b.push(d))
    publishChatDelta('A', delta('agent:x:team:A', 'for-A'))
    expect(a.map((d) => d.text)).toEqual(['for-A'])
    expect(b).toEqual([])
    ua()
    ub()
  })

  it('a publish with no subscribers is a no-op (the no-client invariant)', () => {
    expect(() => publishChatDelta('nobody', delta('agent:x:team:nobody', 'x'))).not.toThrow()
  })

  it('a throwing listener does not break sibling listeners', () => {
    const seen: string[] = []
    const u1 = subscribeChatDelta('T', () => {
      throw new Error('bad listener')
    })
    const u2 = subscribeChatDelta('T', (d) => seen.push(d.text))
    expect(() => publishChatDelta('T', delta('agent:a1:team:T', 'survives'))).not.toThrow()
    expect(seen).toEqual(['survives'])
    u1()
    u2()
  })
})
