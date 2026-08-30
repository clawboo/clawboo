// @vitest-environment jsdom
// Remembering which conversation is open across a reload.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetSession, recallSession, rememberSession } from '../currentSession'

beforeEach(() => {
  globalThis.localStorage.clear()
})

describe('currentSession', () => {
  it('remembers a session per agent and recalls it', () => {
    rememberSession('a1', 'agent:a1:dashboard:abc')
    rememberSession('a2', 'agent:a2:dashboard:def')
    expect(recallSession('a1')).toBe('agent:a1:dashboard:abc')
    expect(recallSession('a2')).toBe('agent:a2:dashboard:def')
  })

  it('returns null for an agent it has never seen', () => {
    // Null is what tells the caller to use the main session, so it must be
    // distinguishable from a remembered empty string.
    expect(recallSession('nobody')).toBeNull()
  })

  it('overwrites rather than accumulating', () => {
    rememberSession('a1', 'first')
    rememberSession('a1', 'second')
    expect(recallSession('a1')).toBe('second')
  })

  it('forgets one agent without disturbing the others', () => {
    rememberSession('a1', 'one')
    rememberSession('a2', 'two')
    forgetSession('a1')
    expect(recallSession('a1')).toBeNull()
    expect(recallSession('a2')).toBe('two')
  })

  it('ignores empty inputs rather than storing them', () => {
    rememberSession('', 'x')
    rememberSession('a1', '')
    expect(recallSession('')).toBeNull()
    expect(recallSession('a1')).toBeNull()
  })

  it('degrades to the default when storage holds junk', () => {
    // An older build, a half-written value, or a user poking at devtools. Any of
    // them must mean "use main", never a crash on boot.
    globalThis.localStorage.setItem('clawboo:chat:session:v1', 'not json')
    expect(recallSession('a1')).toBeNull()
    globalThis.localStorage.setItem('clawboo:chat:session:v1', '["an","array"]')
    expect(recallSession('a1')).toBeNull()
    globalThis.localStorage.setItem('clawboo:chat:session:v1', '{"a1":42}')
    expect(recallSession('a1')).toBeNull()
  })

  it('never throws when storage itself fails', () => {
    const boom = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => rememberSession('a1', 'x')).not.toThrow()
    boom.mockRestore()
  })
})

describe('the reload path this exists to fix', () => {
  it('survives the boot rebuild that used to reset every agent to main', () => {
    // The reported failure, reproduced as the two steps that produce it.
    // 1. /reset adopts a fresh session and remembers it.
    rememberSession('code-reviewer-boo', 'agent:code-reviewer-boo:dashboard:567b7c41')
    // 2. Boot rebuilds the fleet. It used to write `agent:<id>:main` here
    //    unconditionally, which put the chat back on the previous conversation
    //    while the reply sat under the key above.
    const mainKey = 'main'
    const agentId = 'code-reviewer-boo'
    const resolved = recallSession(agentId) ?? `agent:${agentId}:${mainKey}`
    expect(resolved).toBe('agent:code-reviewer-boo:dashboard:567b7c41')
  })

  it('still falls back to main for an agent that was never reset', () => {
    const agentId = 'doc-writer-boo'
    expect(recallSession(agentId) ?? `agent:${agentId}:main`).toBe('agent:doc-writer-boo:main')
  })
})
