import { beforeEach, describe, expect, it } from 'vitest'

import { useBoardStore } from '../board'

describe('useBoardStore.applyChange (a check waiting for the team folder)', () => {
  const get = () => useBoardStore.getState().tasksByTeam.get('held')?.get('task-1')

  it('marks the card while the check waits, and clears it when the check starts', () => {
    const s = useBoardStore.getState()
    s.applyChange('held', { id: 'task-1', status: 'in_progress', updatedAt: 100 })
    expect(get()?.checkHeldSince).toBeNull()

    s.applyChange('held', {
      id: 'task-1',
      status: 'in_review',
      checkHeldSince: 150,
      updatedAt: 150,
    })
    expect(get()?.checkHeldSince).toBe(150)

    // A later frame that does not say keeps it; the check starting ends it.
    s.applyChange('held', { id: 'task-1', status: 'in_review', updatedAt: 160 })
    expect(get()?.checkHeldSince).toBe(150)
    s.applyChange('held', {
      id: 'task-1',
      status: 'in_review',
      checkHeldSince: null,
      updatedAt: 170,
    })
    expect(get()?.checkHeldSince).toBeNull()
  })

  it('ends with a move out of review', () => {
    const s = useBoardStore.getState()
    s.applyChange('held', {
      id: 'task-1',
      status: 'in_review',
      checkHeldSince: 200,
      updatedAt: 200,
    })
    s.applyChange('held', { id: 'task-1', status: 'done', updatedAt: 210 })
    expect(get()?.checkHeldSince).toBeNull()
  })
})

describe('useBoardStore.applyChange (projection merge)', () => {
  beforeEach(() => useBoardStore.getState().reset('t1'))

  it('creates then merges a task by id (later fields win, earlier preserved)', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', {
      id: 'task-1',
      title: 'Fix bug',
      status: 'todo',
      createdAt: 100,
      updatedAt: 100,
    })
    s.applyChange('t1', {
      id: 'task-1',
      status: 'in_progress',
      assigneeAgentId: 'a2',
      updatedAt: 200,
    })
    const task = useBoardStore.getState().tasksByTeam.get('t1')!.get('task-1')!
    expect(task.title).toBe('Fix bug') // preserved from create
    expect(task.status).toBe('in_progress') // updated
    expect(task.assigneeAgentId).toBe('a2')
    expect(task.createdAt).toBe(100)
  })

  it('keeps the summary additively — a later non-summary change does not erase it', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', { id: 'task-1', status: 'done', summary: 'all done', updatedAt: 300 })
    s.applyChange('t1', { id: 'task-1', status: 'done', updatedAt: 400 })
    const task = useBoardStore.getState().tasksByTeam.get('t1')!.get('task-1')!
    expect(task.summary).toBe('all done')
  })

  it('does NOT regress a field when a strictly-older change arrives (reconnect load vs live frame)', () => {
    const s = useBoardStore.getState()
    // A live board SSE frame lands during a reconnect gap: task → done at T2.
    s.applyChange('t1', {
      id: 'task-1',
      title: 'Fix bug',
      status: 'done',
      summary: 'shipped',
      updatedAt: 200,
    })
    // The `open`-triggered `load()` returns an older REST snapshot (T1 < T2) — it must
    // NOT roll the card backward to in_progress.
    s.applyChange('t1', {
      id: 'task-1',
      title: 'Fix bug',
      status: 'in_progress',
      assigneeAgentId: 'a2',
      updatedAt: 100,
    })
    const task = useBoardStore.getState().tasksByTeam.get('t1')!.get('task-1')!
    expect(task.status).toBe('done') // NOT regressed
    expect(task.summary).toBe('shipped') // preserved
    expect(task.updatedAt).toBe(200) // newer time kept
  })

  it('isolates teams and resets one without touching another', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', { id: 'task-1', status: 'todo', updatedAt: 1 })
    s.applyChange('t2', { id: 'task-9', status: 'todo', updatedAt: 1 })
    s.reset('t1')
    expect(useBoardStore.getState().tasksByTeam.get('t1')).toBeUndefined()
    expect(useBoardStore.getState().tasksByTeam.get('t2')?.get('task-9')).toBeDefined()
    useBoardStore.getState().reset('t2')
  })
})
