import { describe, expect, it } from 'vitest'

import { isToolInScope, matchesAny, matchesGlob } from '../index'

describe('matchesGlob', () => {
  it('matches everything on a bare star', () => {
    expect(matchesGlob('*', 'anything')).toBe(true)
    expect(matchesGlob('*', '')).toBe(true)
  })

  it('is exact when the pattern has no star', () => {
    expect(matchesGlob('read_file', 'read_file')).toBe(true)
    expect(matchesGlob('read_file', 'read_files')).toBe(false)
    expect(matchesGlob('read_file', 'xread_file')).toBe(false)
  })

  it('anchors at both ends', () => {
    expect(matchesGlob('github_*', 'github_create_issue')).toBe(true)
    expect(matchesGlob('github_*', 'x_github_create_issue')).toBe(false)
    expect(matchesGlob('*_issue', 'github_create_issue')).toBe(true)
    expect(matchesGlob('*_issue', 'github_create_issue_x')).toBe(false)
  })

  it('matches an empty run for a star', () => {
    expect(matchesGlob('github_*', 'github_')).toBe(true)
    expect(matchesGlob('a*b', 'ab')).toBe(true)
  })

  it('rejects when the anchors would have to overlap', () => {
    // 'ab' is too short to satisfy a 2-char prefix AND a 1-char suffix.
    expect(matchesGlob('ab*b', 'ab')).toBe(false)
    expect(matchesGlob('ab*b', 'abb')).toBe(true)
  })

  it('handles interior segments', () => {
    expect(matchesGlob('mcp__*__read_*', 'mcp__gh__read_file')).toBe(true)
    expect(matchesGlob('mcp__*__read_*', 'mcp__gh__write_file')).toBe(false)
  })

  it('treats dots and dashes as literal, not regex metacharacters', () => {
    expect(matchesGlob('a.b', 'axb')).toBe(false)
    expect(matchesGlob('a.b', 'a.b')).toBe(true)
    expect(matchesGlob('a-b', 'a-b')).toBe(true)
  })

  it('does not let a pattern smuggle in a regex', () => {
    // If patterns were compiled to a RegExp, this would match anything.
    expect(matchesGlob('.*', 'whatever')).toBe(false)
    expect(matchesGlob('.*', '.*')).toBe(true)
  })
})

describe('matchesAny', () => {
  it('is false for an empty pattern list', () => {
    expect(matchesAny([], 'read_file')).toBe(false)
  })

  it('is true when any pattern matches', () => {
    expect(matchesAny(['write_*', 'read_*'], 'read_file')).toBe(true)
  })
})

describe('isToolInScope', () => {
  it('allows a star-allow with no deny', () => {
    expect(isToolInScope({ allow: ['*'], deny: [], name: 'read_file' })).toBe(true)
  })

  it('treats an empty allow-list as NO tools, not all of them', () => {
    expect(isToolInScope({ allow: [], deny: [], name: 'read_file' })).toBe(false)
  })

  it('lets deny win over allow', () => {
    expect(isToolInScope({ allow: ['*'], deny: ['delete_*'], name: 'delete_repo' })).toBe(false)
    expect(isToolInScope({ allow: ['*'], deny: ['delete_*'], name: 'read_file' })).toBe(true)
  })

  it('denies a tool outside an explicit subset', () => {
    expect(isToolInScope({ allow: ['read_file'], deny: [], name: 'write_file' })).toBe(false)
  })
})
