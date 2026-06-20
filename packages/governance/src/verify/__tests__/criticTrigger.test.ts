import { describe, expect, it } from 'vitest'

import { shouldRunCritic } from '../index'

const small = { filesChanged: 1, insertions: 10, deletions: 2 }
const large = { filesChanged: 12, insertions: 400, deletions: 50 }

describe('shouldRunCritic', () => {
  it('skips a small, top-level, low-risk diff', () => {
    expect(shouldRunCritic({ diffStat: small, hasParent: false })).toBe(false)
  })
  it('always runs on explicit risk', () => {
    expect(shouldRunCritic({ diffStat: small, hasParent: false, riskFlag: true })).toBe(true)
  })
  it('always runs on delegated work (depth > 0)', () => {
    expect(shouldRunCritic({ diffStat: small, hasParent: true })).toBe(true)
  })
  it('runs over the file or line threshold', () => {
    expect(shouldRunCritic({ diffStat: large, hasParent: false })).toBe(true)
    expect(
      shouldRunCritic({
        diffStat: { filesChanged: 1, insertions: 350, deletions: 0 },
        hasParent: false,
      }),
    ).toBe(true)
  })
  it('honors a custom threshold', () => {
    expect(
      shouldRunCritic({
        diffStat: { filesChanged: 3, insertions: 0, deletions: 0 },
        hasParent: false,
        threshold: { files: 2 },
      }),
    ).toBe(true)
  })
})
