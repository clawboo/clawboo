// The pinned-version gate. Everything here is a real shape the MCP registry's
// publisher-supplied `version` field can carry, because nothing upstream
// validates it.

import { describe, expect, it } from 'vitest'

import { isExactVersion } from '../version'

describe('isExactVersion', () => {
  it('accepts exact npm releases, including prerelease and build metadata', () => {
    expect(isExactVersion('1.2.3', 'npm')).toBe(true)
    expect(isExactVersion('0.0.1', 'npm')).toBe(true)
    expect(isExactVersion('1.2.3-rc.1', 'npm')).toBe(true)
    expect(isExactVersion('1.2.3-beta', 'npm')).toBe(true)
    expect(isExactVersion('1.2.3+build.5', 'npm')).toBe(true)
  })

  it('accepts exact PyPI releases in the shapes PEP 440 actually produces', () => {
    expect(isExactVersion('1.2.3', 'pypi')).toBe(true)
    expect(isExactVersion('2024.1', 'pypi')).toBe(true)
    expect(isExactVersion('1.0rc1', 'pypi')).toBe(true)
    expect(isExactVersion('1.0.post1', 'pypi')).toBe(true)
    expect(isExactVersion('1!2.0', 'pypi')).toBe(true)
  })

  it('refuses dist-tags, which are the whole reason this exists', () => {
    for (const tag of ['latest', 'next', 'beta', 'stable', 'canary']) {
      expect(isExactVersion(tag, 'npm')).toBe(false)
      expect(isExactVersion(tag, 'pypi')).toBe(false)
    }
  })

  it('refuses ranges', () => {
    for (const range of ['^1.2.0', '~1.2', '>=1.0.0', '1.x', '*', '1.2.3 || 2.0.0', '>1,<2']) {
      expect(isExactVersion(range, 'npm')).toBe(false)
      expect(isExactVersion(range, 'pypi')).toBe(false)
    }
  })

  it('refuses URLs, git refs and anything with an @', () => {
    expect(isExactVersion('https://example.com/pkg.tgz', 'npm')).toBe(false)
    expect(isExactVersion('github:owner/repo', 'npm')).toBe(false)
    expect(isExactVersion('pkg@1.2.3', 'npm')).toBe(false)
  })

  it('refuses whitespace rather than trimming it', () => {
    // A version that needed trimming to pass is one whose argv would not match
    // the string that was verified.
    expect(isExactVersion(' 1.2.3', 'npm')).toBe(false)
    expect(isExactVersion('1.2.3\n', 'npm')).toBe(false)
  })

  it('refuses empty, absurd length, and non-strings', () => {
    expect(isExactVersion('', 'npm')).toBe(false)
    expect(isExactVersion(undefined, 'npm')).toBe(false)
    expect(isExactVersion('1.'.repeat(40), 'npm')).toBe(false)
  })

  it('refuses a two-part version for npm, which requires all three parts', () => {
    expect(isExactVersion('1.2', 'npm')).toBe(false)
    // PyPI genuinely allows it, so the same string splits by ecosystem.
    expect(isExactVersion('1.2', 'pypi')).toBe(true)
  })
})
