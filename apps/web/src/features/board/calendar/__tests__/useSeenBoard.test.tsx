// What the person has seen holds under every team filter that shows the card:
// a change looked at, watched live or marked seen under one filter is not news
// when they switch to another.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBoardStorage } from '../../__tests__/resetBoardStorage'
import type { SeenRecord } from '../seenModel'
import { useSeenBoard, type SeenTask } from '../useSeenBoard'

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0)
const HOUR = 3_600_000

function store(team: string, columns: Record<string, string>, at = T0 - 2 * HOUR): void {
  const rec: SeenRecord = { v: 1, at, watching: false, columns, pending: null }
  window.localStorage.setItem(`clawboo.board.seen.${team}`, JSON.stringify(rec))
}

function stored(team: string): SeenRecord {
  return JSON.parse(window.localStorage.getItem(`clawboo.board.seen.${team}`)!) as SeenRecord
}

const X_DONE: SeenTask = { id: 'x', column: 'done', teamId: 'team-a' }

beforeEach(() => {
  resetBoardStorage()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

function mount(team: string) {
  return renderHook(({ t }) => useSeenBoard(t), { initialProps: { t: team } })
}

describe('useSeenBoard across team filters', () => {
  it('counts a card looked at under All as seen under its own team', () => {
    store('all', { x: 'todo' })
    store('team-a', { x: 'todo' })
    const hook = mount('all')
    act(() => hook.result.current.noteBoardRead('all', [X_DONE]))
    expect(hook.result.current.summary?.counts.done).toBe(1)

    act(() => hook.result.current.acknowledge(['x']))
    expect(hook.result.current.summary).toBeNull()

    hook.rerender({ t: 'team-a' })
    act(() => hook.result.current.noteBoardRead('team-a', [X_DONE]))
    expect(hook.result.current.summary).toBeNull()
    expect(stored('team-a').columns['x']).toBe('done')
  })

  it('does not report under another filter a change the person watched happen', () => {
    store('all', { x: 'todo' })
    store('team-a', { x: 'todo' })
    const hook = mount('team-a')
    // The first read is a return; nothing has moved yet.
    act(() => hook.result.current.noteBoardRead('team-a', [{ ...X_DONE, column: 'todo' }]))
    // Five seconds later, while they watch, it finishes.
    vi.setSystemTime(T0 + 5000)
    act(() => hook.result.current.noteBoardRead('team-a', [X_DONE]))
    expect(hook.result.current.summary).toBeNull()

    hook.rerender({ t: 'all' })
    vi.setSystemTime(T0 + 10_000)
    act(() => hook.result.current.noteBoardRead('all', [X_DONE]))
    expect(hook.result.current.summary).toBeNull()
  })

  it('still reports what changed under a filter the person was not watching', () => {
    store('all', { x: 'todo', y: 'todo' })
    store('team-b', { y: 'todo' })
    const hook = mount('team-a')
    act(() => hook.result.current.noteBoardRead('team-a', [{ ...X_DONE, column: 'todo' }]))
    vi.setSystemTime(T0 + 5000)
    // Team B's card finishes while the person watches team A.
    act(() => hook.result.current.noteBoardRead('team-a', [{ ...X_DONE, column: 'todo' }]))

    hook.rerender({ t: 'team-b' })
    vi.setSystemTime(T0 + 10_000)
    act(() =>
      hook.result.current.noteBoardRead('team-b', [{ id: 'y', column: 'done', teamId: 'team-b' }]),
    )
    expect(hook.result.current.summary?.counts.done).toBe(1)
  })

  it('clears a card marked seen under All from its team too', () => {
    store('all', { x: 'todo' })
    store('team-a', { x: 'todo' })
    const hook = mount('all')
    act(() => hook.result.current.noteBoardRead('all', [X_DONE]))
    act(() => hook.result.current.markAllSeen())
    expect(hook.result.current.summary).toBeNull()

    hook.rerender({ t: 'team-a' })
    act(() => hook.result.current.noteBoardRead('team-a', [X_DONE]))
    expect(hook.result.current.summary).toBeNull()
  })

  it('takes a task the person made for another team as seen there', () => {
    store('all', {})
    store('team-b', {})
    const hook = mount('all')
    act(() => hook.result.current.noteBoardRead('all', []))
    act(() => hook.result.current.absorbTask('n', 'todo', 'team-b'))

    hook.rerender({ t: 'team-b' })
    act(() =>
      hook.result.current.noteBoardRead('team-b', [{ id: 'n', column: 'todo', teamId: 'team-b' }]),
    )
    expect(hook.result.current.summary).toBeNull()
  })
})
