import { beforeEach, describe, expect, it, vi } from 'vitest'

import { boardClient } from '@/lib/boardClient'

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

describe('useBoardStore: person tasks, waits and Reopen', () => {
  beforeEach(() => useBoardStore.getState().reset('t1'))
  const task = () => useBoardStore.getState().tasksByTeam.get('t1')!.get('task-1')!

  it('a person taking the task takes the agent off, as the server did', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', { id: 'task-1', status: 'blocked', assigneeAgentId: 'a2', updatedAt: 100 })
    s.applyChange('t1', {
      id: 'task-1',
      status: 'blocked',
      assigneePersonId: 'local',
      assigneePerson: '{"id":"local","name":"You","role":null}',
      updatedAt: 200,
    })
    expect(task().assigneeAgentId).toBeNull()
    expect(task().assigneePersonId).toBe('local')
    // A frame that does not say keeps who has it.
    s.applyChange('t1', { id: 'task-1', summary: 'note', updatedAt: 300 })
    expect(task().assigneePersonId).toBe('local')
  })

  it('a person giving it back clears them', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', { id: 'task-1', status: 'todo', assigneePersonId: 'local', updatedAt: 100 })
    s.applyChange('t1', { id: 'task-1', status: 'todo', assigneePersonId: null, updatedAt: 200 })
    expect(task().assigneePersonId).toBeNull()
  })

  it('carries what a task waits on, and drops it when the card moves without saying', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', {
      id: 'task-1',
      status: 'blocked',
      waitingOn: '{"kind":"subtasks"}',
      waitingOnDetail: { openSubtasks: 2 },
      updatedAt: 100,
    })
    expect(task().waitingOn).toBe('{"kind":"subtasks"}')
    expect(task().waitingOnDetail).toEqual({ openSubtasks: 2 })
    s.applyChange('t1', { id: 'task-1', status: 'blocked', updatedAt: 150 })
    expect(task().waitingOn).toBe('{"kind":"subtasks"}')
    s.applyChange('t1', { id: 'task-1', status: 'todo', updatedAt: 200 })
    expect(task().waitingOn).toBeUndefined()
    expect(task().waitingOnDetail).toBeUndefined()
  })

  it('a reopened task forgets the report of the run that finished it', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', { id: 'task-1', status: 'done', summary: 'all done', updatedAt: 100 })
    s.applyChange('t1', { id: 'task-1', status: 'todo', updatedAt: 200 })
    expect(task().summary).toBeNull()
  })

  it('a task that failed and runs again keeps nothing sticky from Done, and a live summary still lands', () => {
    const s = useBoardStore.getState()
    s.applyChange('t1', { id: 'task-1', status: 'cancelled', summary: 'dropped', updatedAt: 100 })
    s.applyChange('t1', { id: 'task-1', status: 'todo', summary: 'fresh', updatedAt: 200 })
    expect(task().summary).toBe('fresh')
  })
})

describe('board store: who a loaded task is with', () => {
  beforeEach(() => useBoardStore.getState().reset('t1'))

  const load = async (row: Record<string, unknown>) => {
    vi.spyOn(boardClient, 'listTasks').mockResolvedValue([
      { id: 'task-1', title: 'Work', status: 'todo', updatedAt: 100, ...row },
    ] as never)
    await useBoardStore.getState().load('t1')
    vi.restoreAllMocks()
    return useBoardStore.getState().tasksByTeam.get('t1')!.get('task-1')!
  }

  it('names the agent a task is bound to, as the board does', async () => {
    const task = await load({ sourceDelegationId: 'r1:deleg:agent:a1:reflectTo:lead' })
    expect(task.assigneeAgentId).toBe('a1')
  })

  it('leaves a task nobody is bound to unassigned', async () => {
    expect((await load({})).assigneeAgentId).toBeNull()
  })

  it('never names an agent on a task a person has', async () => {
    const task = await load({
      sourceDelegationId: 'r1:deleg:agent:a1:reflectTo:lead',
      assigneePersonId: 'p1',
    })
    expect(task.assigneeAgentId).toBeNull()
  })
})
