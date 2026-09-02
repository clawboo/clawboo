// @vitest-environment jsdom
// Reading the conversation an agent's chat was moved onto before resets stopped
// minting new keys. Read-only by design: nothing writes this store any more.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recallSession } from '../currentSession'

const KEY = 'clawboo:chat:session:v1'

beforeEach(() => {
  globalThis.localStorage.clear()
})

describe('recallSession', () => {
  it('returns the stored key for that agent, and only that agent', () => {
    globalThis.localStorage.setItem(
      KEY,
      JSON.stringify({ a1: 'agent:a1:dashboard:abc', a2: 'agent:a2:dashboard:def' }),
    )
    expect(recallSession('a1')).toBe('agent:a1:dashboard:abc')
    expect(recallSession('a2')).toBe('agent:a2:dashboard:def')
  })

  it('returns null for an agent that was never moved', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ a1: 'agent:a1:dashboard:abc' }))
    expect(recallSession('nobody')).toBeNull()
    expect(recallSession('')).toBeNull()
  })

  it('returns null when there is nothing stored', () => {
    expect(recallSession('a1')).toBeNull()
  })

  it('survives junk left by an older build', () => {
    // Every bad shape degrades to "use the main session", which is what a chat
    // with no stored key does anyway.
    for (const junk of ['not json', '[]', 'null', '"a string"', '{"a1":42}', '{"a1":""}']) {
      globalThis.localStorage.setItem(KEY, junk)
      expect(recallSession('a1')).toBeNull()
    }
  })

  it('survives storage being unavailable entirely', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(recallSession('a1')).toBeNull()
    spy.mockRestore()
  })
})
