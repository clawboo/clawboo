// The attach-scope signature: the primitive the loopback identity story now
// rests on. Every property here is one a runtime editing its own config would
// need to break.

import { describe, expect, it } from 'vitest'

import { signAttachScope, verifyAttachScope } from '../attachAuth'
import { mcpHttpUrl } from '../config'

const SECRET = 'a'.repeat(64)

describe('signAttachScope / verifyAttachScope', () => {
  it('round-trips the scope it signed', () => {
    const scope = { teamId: 'T', agentId: 'A', delegate: true }
    expect(verifyAttachScope(SECRET, scope, signAttachScope(SECRET, scope))).toBe(true)
  })

  it('any changed field breaks verification — including the delegate PRIVILEGE', () => {
    const scope = { teamId: 'T', agentId: 'A', delegate: false }
    const sig = signAttachScope(SECRET, scope)
    expect(verifyAttachScope(SECRET, { ...scope, agentId: 'victim' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, { ...scope, teamId: 'other' }, sig)).toBe(false)
    expect(verifyAttachScope(SECRET, { ...scope, delegate: true }, sig)).toBe(false)
  })

  it('fields cannot BLEED into each other', () => {
    // Without a separator, {teamId:'ab', agentId:'c'} and {teamId:'a', agentId:'bc'}
    // would canonicalise identically and one signature would cover both identities.
    const sig = signAttachScope(SECRET, { teamId: 'ab', agentId: 'c' })
    expect(verifyAttachScope(SECRET, { teamId: 'a', agentId: 'bc' }, sig)).toBe(false)
  })

  it('a different secret verifies nothing', () => {
    const scope = { teamId: 'T', agentId: 'A' }
    expect(verifyAttachScope('b'.repeat(64), scope, signAttachScope(SECRET, scope))).toBe(false)
  })

  it('malformed signatures are false, never a throw', () => {
    const scope = { teamId: 'T' }
    for (const bad of ['', 'zz', 'deadbeef', 'not hex', signAttachScope(SECRET, scope).slice(2)]) {
      expect(verifyAttachScope(SECRET, scope, bad)).toBe(false)
    }
  })

  it('is deterministic, so attach configs stay byte-stable across rewrites', () => {
    // The codex driver's auth-seeding uses mtime freshness on files in the run
    // home; a signature that changed per write would churn every config.
    const scope = { teamId: 'T', agentId: 'A' }
    expect(signAttachScope(SECRET, scope)).toBe(signAttachScope(SECRET, scope))
  })
})

describe('mcpHttpUrl signing', () => {
  it('a signed tasks URL replayed as a teamchat+delegate URL cannot verify', () => {
    // Cross-server replay: lift the sig off the tasks URL, present it with
    // delegate=1 on teamchat. Tasks signs delegate:false by construction, so the
    // replay claims a scope the signature does not cover.
    const url = new URL(
      mcpHttpUrl('http://x', 'tasks', { teamId: 'T', agentId: 'A', attachSecret: SECRET }),
    )
    const sig = url.searchParams.get('scopeSig')!
    expect(sig).toBeTruthy()
    expect(verifyAttachScope(SECRET, { teamId: 'T', agentId: 'A', delegate: true }, sig)).toBe(
      false,
    )
  })

  it('never leaks the secret into the URL', () => {
    const secret = 'f0e1d2c3'.repeat(8)
    for (const server of ['tasks', 'memory', 'teamchat'] as const) {
      const url = mcpHttpUrl('http://x', server, {
        teamId: 'T',
        agentId: 'A',
        attachSecret: secret,
      })
      expect(url).not.toContain(secret)
      expect(url).toContain('scopeSig=')
    }
  })

  it('an unscoped URL carries no signature at all', () => {
    expect(mcpHttpUrl('http://x', 'tools')).not.toContain('scopeSig')
    expect(mcpHttpUrl('http://x', 'tasks')).not.toContain('scopeSig')
  })
})
