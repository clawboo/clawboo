// Pure drag-resolution logic — the primary DnD coverage, since dnd-kit's real
// pointer drag can't run in jsdom (no layout/rects). Exercises the (activeId,
// overId, tasks) → move | null contract exhaustively.

import { describe, expect, it } from 'vitest'

import type { BoardTask } from '@/lib/boardClient'

import { resolveDrop } from '../resolveDrop'

const tasks: BoardTask[] = [
  { id: 't1', status: 'todo', title: 'A' },
  { id: 't2', status: 'in_progress', title: 'B' },
  { id: 't3', status: 'done', title: 'C' },
]

describe('resolveDrop', () => {
  it('resolves a drop onto a different column to a from→to move', () => {
    expect(resolveDrop('t1', 'in_progress', tasks)).toEqual({
      taskId: 't1',
      from: 'todo',
      to: 'in_progress',
    })
  })

  it('is a no-op when dropped back on the card’s own column', () => {
    expect(resolveDrop('t1', 'todo', tasks)).toBeNull()
  })

  it('is a no-op when dropped outside any column (over = null)', () => {
    expect(resolveDrop('t1', null, tasks)).toBeNull()
  })

  it('is a no-op for an unknown task id', () => {
    expect(resolveDrop('ghost', 'done', tasks)).toBeNull()
  })

  it('returns the target column verbatim (legality is enforced downstream)', () => {
    // todo→done is illegal per the state machine, but resolveDrop is purely
    // geometric — it reports the intent; useStatusMutation rejects the illegal move.
    expect(resolveDrop('t1', 'done', tasks)).toEqual({ taskId: 't1', from: 'todo', to: 'done' })
    // Same for the catch-all "Other" column id.
    expect(resolveDrop('t1', '__other__', tasks)).toEqual({
      taskId: 't1',
      from: 'todo',
      to: '__other__',
    })
  })

  it('resolves against the passed statuses (so optimistic overrides are respected)', () => {
    // A card already optimistically moved to in_review resolves its next move from there.
    const moved: BoardTask[] = [{ id: 't1', status: 'in_review', title: 'A' }]
    expect(resolveDrop('t1', 'done', moved)).toEqual({
      taskId: 't1',
      from: 'in_review',
      to: 'done',
    })
  })
})
