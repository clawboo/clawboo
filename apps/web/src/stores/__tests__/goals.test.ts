// Each team's goals for the Board. A forced read (Home changed a goal) always reads
// again, even while an older read is in flight, and only the newest answer is kept:
// a read that began before the change can never land last and leave a stale list. A
// failed read is never kept as "no goals".

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GoalSummary } from '@clawboo/control-client'

const listGoals = vi.fn<(teamId: string) => Promise<GoalSummary[]>>()

vi.mock('@clawboo/control-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clawboo/control-client')>()),
  listGoals: (teamId: string) => listGoals(teamId),
}))

const { resetGoalsStore, useGoalsStore } = await import('../goals')

function summary(id: string, title: string): GoalSummary {
  return {
    goal: {
      id,
      teamId: 't1',
      parentGoalId: null,
      title,
      description: '',
      owner: null,
      targetDate: null,
      status: 'active',
      health: null,
      healthSetBy: null,
      healthSetAt: null,
      updateCadenceDays: 7,
      position: 0,
      createdBy: null,
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
    },
    progress: { total: 0, done: 0, doneChecked: 0, addedLast7Days: 0, doneLast7Days: 0 },
    cost: { usd: 0, includesEstimates: false },
    lastUpdateAt: null,
    updateMissing: false,
    draftCount: 0,
    childCount: 0,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const titles = () => (useGoalsStore.getState().byTeam['t1'] ?? []).map((g) => g.title)

beforeEach(() => {
  resetGoalsStore()
  listGoals.mockReset()
})

describe('the goals store', () => {
  it('reads once for callers that do not force', async () => {
    listGoals.mockResolvedValue([summary('g1', 'Launch')])
    await Promise.all([useGoalsStore.getState().load('t1'), useGoalsStore.getState().load('t1')])
    await useGoalsStore.getState().load('t1')
    expect(listGoals).toHaveBeenCalledTimes(1)
    expect(titles()).toEqual(['Launch'])
  })

  it('reads again on a forced load while an older read is in flight, and keeps the newer answer', async () => {
    const older = deferred<GoalSummary[]>()
    const newer = deferred<GoalSummary[]>()
    listGoals.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)

    const first = useGoalsStore.getState().load('t1', true)
    // A goal is renamed while that read is out: Home forces another read.
    const second = useGoalsStore.getState().load('t1', true)
    expect(listGoals).toHaveBeenCalledTimes(2)

    newer.resolve([summary('g1', 'Launch the beta')])
    await second
    // The older read lands last, and must not overwrite the newer list.
    older.resolve([summary('g1', 'Launch')])
    await first
    expect(titles()).toEqual(['Launch the beta'])
  })

  it('re-reads when invalidated during the first read', async () => {
    const first = deferred<GoalSummary[]>()
    listGoals
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([summary('g1', 'Launch the beta')])
    const loading = useGoalsStore.getState().load('t1')
    useGoalsStore.getState().invalidate('t1')
    expect(listGoals).toHaveBeenCalledTimes(2)
    first.resolve([summary('g1', 'Launch')])
    await loading
    await vi.waitFor(() => expect(titles()).toEqual(['Launch the beta']))
  })

  it('caches nothing when a first read fails, so the next load reads again', async () => {
    listGoals.mockRejectedValueOnce(new Error('no Home here'))
    expect(await useGoalsStore.getState().load('t1')).toBeNull()
    expect(useGoalsStore.getState().byTeam['t1']).toBeUndefined()
    listGoals.mockResolvedValueOnce([summary('g1', 'Launch')])
    await useGoalsStore.getState().load('t1')
    expect(listGoals).toHaveBeenCalledTimes(2)
    expect(titles()).toEqual(['Launch'])
  })

  it('keeps the last good list when a refresh fails', async () => {
    listGoals.mockResolvedValueOnce([summary('g1', 'Launch')])
    await useGoalsStore.getState().load('t1')
    listGoals.mockRejectedValueOnce(new Error('offline'))
    expect((await useGoalsStore.getState().load('t1', true))?.map((g) => g.title)).toEqual([
      'Launch',
    ])
    expect(titles()).toEqual(['Launch'])
  })
})
