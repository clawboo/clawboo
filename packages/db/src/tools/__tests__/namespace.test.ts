import { describe, expect, it } from 'vitest'

import { isConnectorToolName, namespacedToolName, parseNamespacedToolName } from '../namespace'

describe('connector tool namespacing', () => {
  it('round-trips a slug and a remote name', () => {
    const made = namespacedToolName('github', 'create_issue')
    expect(made).toEqual({ ok: true, name: 'mcp__github__create_issue' })
    expect(parseNamespacedToolName('mcp__github__create_issue')).toEqual({
      slug: 'github',
      remoteName: 'create_issue',
    })
  })

  it('round-trips a remote name that itself contains the separator', () => {
    // The slug can never contain `_`, so splitting on the first two separators
    // is unambiguous even when the remote half has more.
    const made = namespacedToolName('linear', 'a__b__c')
    expect(made.ok && made.name).toBe('mcp__linear__a__b__c')
    expect(parseNamespacedToolName('mcp__linear__a__b__c')).toEqual({
      slug: 'linear',
      remoteName: 'a__b__c',
    })
  })

  it('REJECTS a name it would have to rewrite, rather than rewriting it', () => {
    // Providers fold every character outside [A-Za-z0-9_-] to `_`, and that is
    // not injective: `a.b` and `a_b` would arrive as one name. A rewritten name
    // also no longer matches what the server accepts on tools/call.
    expect(namespacedToolName('github', 'a.b')).toEqual({
      ok: false,
      reason: 'unrepresentable-name',
    })
    expect(namespacedToolName('github', 'has space')).toEqual({
      ok: false,
      reason: 'unrepresentable-name',
    })
  })

  it('rejects a slug that is not catalog-shaped', () => {
    // An underscore in the slug would make the split ambiguous.
    expect(namespacedToolName('bad_slug', 'x').ok).toBe(false)
    expect(namespacedToolName('Bad', 'x').ok).toBe(false)
    expect(namespacedToolName('', 'x').ok).toBe(false)
  })

  it('rejects an over-long name instead of truncating it', () => {
    // Truncation collides two tools onto one name, which is worse than losing
    // one tool.
    const out = namespacedToolName('github', 'x'.repeat(200))
    expect(out).toEqual({ ok: false, reason: 'name-too-long' })
  })

  it('parses EXACTLY what it can construct, and nothing else', () => {
    // A looser parser classifies a name the constructor refuses to emit as a
    // valid connector tool, so a name from a persisted row or a hand-written
    // config would be routed on the strength of its prefix alone.
    for (const remote of ['a.b', 'has space', 'x'.repeat(200)]) {
      expect(namespacedToolName('github', remote).ok).toBe(false)
      expect(parseNamespacedToolName(`mcp__github__${remote}`)).toBeNull()
      expect(isConnectorToolName(`mcp__github__${remote}`)).toBe(false)
    }
  })

  it('does not mistake a builtin for a connector tool', () => {
    expect(isConnectorToolName('echo')).toBe(false)
    expect(isConnectorToolName('mcp__github__x')).toBe(true)
    // Prefix present but no second separator: not a valid namespaced name.
    expect(parseNamespacedToolName('mcp__github')).toBeNull()
    expect(parseNamespacedToolName('mcp____x')).toBeNull()
  })
})
