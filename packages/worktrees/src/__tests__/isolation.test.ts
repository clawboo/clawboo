import { describe, expect, it } from 'vitest'

import { isolationForTask, needsWorktree } from '../isolation'

describe('isolation policy', () => {
  it('isolates file-mutating code work in a worktree', () => {
    expect(isolationForTask('code')).toBe('worktree')
    expect(needsWorktree('code')).toBe(true)
  })

  it('gives read-only research or review a task folder, not a worktree', () => {
    expect(isolationForTask('research')).toBe('folder')
    expect(isolationForTask('review')).toBe('folder')
    expect(needsWorktree('research')).toBe(false)
    expect(needsWorktree('review')).toBe(false)
  })

  it('defaults an unknown kind to the concurrency-safe choice (worktree)', () => {
    expect(isolationForTask('something-new')).toBe('worktree')
  })
})
