import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LINK_TOKEN_PREFIX,
  LinkLimitError,
  linkAgentStamp,
  MAX_LINK_TTL_MS,
  listLinks,
  mintLink,
  onLinkEnded,
  resetLinksForTests,
  resolveLink,
  revokeAllLinks,
  revokeLink,
} from '../links'

let now = 1_000_000
beforeEach(() => {
  now = 1_000_000
  resetLinksForTests(() => now)
})
afterEach(() => resetLinksForTests())

describe('computer links', () => {
  it('mints an unguessable token that resolves to its own agent and kind only', () => {
    const a = mintLink('agent-a', 'view')
    const b = mintLink('agent-b', 'control')
    expect(a.token.startsWith(LINK_TOKEN_PREFIX)).toBe(true)
    expect(a.token.length).toBeGreaterThan(40)
    expect(a.token).not.toBe(b.token)
    expect(resolveLink(a.token)).toMatchObject({ agentId: 'agent-a', kind: 'view' })
    expect(resolveLink(b.token)).toMatchObject({ agentId: 'agent-b', kind: 'control' })
  })

  it('never lists or returns the token or its hash', () => {
    const { token } = mintLink('agent-a', 'control')
    const listed = JSON.stringify(listLinks('agent-a'))
    expect(listed).not.toContain(token)
    expect(listed).not.toContain(
      token.slice(LINK_TOKEN_PREFIX.length, LINK_TOKEN_PREFIX.length + 12),
    )
    expect(Object.keys(listLinks('agent-a')[0]!).sort()).toEqual([
      'agentId',
      'createdAt',
      'expiresAt',
      'id',
      'kind',
    ])
  })

  it('refuses a near miss, a foreign string and nothing', () => {
    const { token } = mintLink('agent-a', 'view')
    expect(resolveLink(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBeNull()
    expect(resolveLink('cbcl_')).toBeNull()
    expect(resolveLink('not-a-link')).toBeNull()
    expect(resolveLink(undefined)).toBeNull()
    expect(resolveLink(token + 'x'.repeat(300))).toBeNull()
  })

  it('expires, and says so to listeners', () => {
    const ended: string[] = []
    onLinkEnded((id) => ended.push(id))
    const { token, link } = mintLink('agent-a', 'control', 5 * 60_000)
    now += 5 * 60_000 - 1
    expect(resolveLink(token)).not.toBeNull()
    now += 1
    expect(resolveLink(token)).toBeNull()
    expect(ended).toEqual([link.id])
  })

  it('caps a lifetime at a day and floors it at a minute', () => {
    const long = mintLink('agent-a', 'view', 10 * MAX_LINK_TTL_MS).link
    expect(long.expiresAt - long.createdAt).toBe(MAX_LINK_TTL_MS)
    const short = mintLink('agent-a', 'view', 5).link
    expect(short.expiresAt - short.createdAt).toBe(60_000)
  })

  it('remembers which agent row a link was made for', () => {
    const { link } = mintLink('agent-a', 'view', undefined, 1234)
    expect(linkAgentStamp(link.id)).toBe(1234)
    expect(JSON.stringify(listLinks('agent-a'))).not.toContain('1234')
  })

  it('refuses a link past the limit rather than revoking one someone may be using', () => {
    const first = mintLink('agent-a', 'view')
    for (let i = 1; i < 20; i++) mintLink('agent-a', 'view')
    expect(() => mintLink('agent-a', 'view')).toThrow(LinkLimitError)
    expect(resolveLink(first.token)).not.toBeNull()
    expect(() => mintLink('agent-b', 'view')).not.toThrow()
  })

  it('revokes one link, only from its own agent, or all of an agent', () => {
    const ended: string[] = []
    onLinkEnded((id) => ended.push(id))
    const a1 = mintLink('agent-a', 'view')
    const a2 = mintLink('agent-a', 'control')
    const b1 = mintLink('agent-b', 'view')
    expect(revokeLink('agent-b', a1.link.id)).toBe(false)
    expect(resolveLink(a1.token)).not.toBeNull()
    expect(revokeLink('agent-a', a1.link.id)).toBe(true)
    expect(resolveLink(a1.token)).toBeNull()
    expect(revokeAllLinks('agent-a')).toBe(1)
    expect(resolveLink(a2.token)).toBeNull()
    expect(resolveLink(b1.token)).not.toBeNull()
    expect(ended).toEqual([a1.link.id, a2.link.id])
  })
})
