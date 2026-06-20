import { describe, expect, it } from 'vitest'

import { isolationForTask, needsWorktree } from '../isolation'

describe('isolation policy', () => {
  it('isolates file-mutating code work in a worktree', () => {
    expect(isolationForTask('code')).toBe('worktree')
    expect(needsWorktree('code')).toBe(true)
  })

  it('does not pay worktree cost for read-only research or review', () => {
    expect(isolationForTask('research')).toBe('none')
    expect(isolationForTask('review')).toBe('none')
    expect(needsWorktree('research')).toBe(false)
    expect(needsWorktree('review')).toBe(false)
  })

  it('defaults an unknown kind to the concurrency-safe choice (worktree)', () => {
    expect(isolationForTask('something-new')).toBe('worktree')
  })
})
