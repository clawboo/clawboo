import { encodePlanHolder } from '@clawboo/board-core'
import { describe, expect, it } from 'vitest'

import {
  buildRequestNesting,
  isMainTask,
  progressLabel,
  requestCost,
  requestLabel,
  tasksOnTheirOwn,
  type NestableTask,
} from '../mainTasks'

const main: NestableTask & { identifier: string; title: string } = {
  id: 'm',
  status: 'in_progress',
  isMainTask: 1,
  identifier: 'CLB-1',
  title: 'Build it',
}
const sub = (id: string, status: string, parentTaskId = 'm', attention: unknown = null) => ({
  id,
  status,
  parentTaskId,
  attention,
})

describe('a request’s nesting', () => {
  it('knows a main task from either source', () => {
    expect(isMainTask({ isMainTask: 1 })).toBe(true)
    expect(isMainTask({ isMainTask: true })).toBe(true)
    expect(isMainTask({ isMainTask: 0 })).toBe(false)
    expect(isMainTask(null)).toBe(false)
  })

  it('finds the main task at any depth, and not above an unrelated task', () => {
    const tasks = [main, sub('a', 'done'), sub('b', 'todo', 'a'), { id: 'x', status: 'todo' }]
    const n = buildRequestNesting(tasks)
    expect(n.mainOf(tasks[2]!)?.id).toBe('m')
    expect(n.mainOf(tasks[3]!)).toBeNull()
    expect(n.mainOf(main)).toBeNull()
    expect(n.subtasksOf('m').map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('counts progress over the whole tree', () => {
    const n = buildRequestNesting([
      main,
      sub('a', 'done'),
      sub('b', 'in_progress', 'a'),
      sub('c', 'cancelled'),
    ])
    expect(n.progressOf('m')).toEqual({ total: 3, done: 1, cancelled: 1, open: 1 })
    expect(progressLabel(n.progressOf('m'))).toBe('1 of 3 done, 1 cancelled')
    expect(progressLabel({ total: 2, done: 2, cancelled: 0, open: 0 })).toBe('2 of 2 done')
  })

  it('does not count a card that only held a plan once it is answered, on either source', () => {
    const card = {
      ...sub('p', 'done'),
      sourceDelegationId: encodePlanHolder('lead', 'x'),
    }
    const nesting = buildRequestNesting([
      main,
      card,
      { ...sub('q', 'cancelled'), planHolder: true },
      sub('a', 'todo'),
      sub('b', 'done'),
    ])
    expect(nesting.progressOf('m')).toEqual({ total: 2, done: 1, cancelled: 0, open: 1 })
    // It stays listed under the request, as a record of what was decided.
    expect(nesting.subtasksOf('m').map((t) => t.id)).toContain('p')
    // Waiting for an answer, it is the one thing open.
    const waiting = buildRequestNesting([
      main,
      { ...sub('p', 'blocked'), sourceDelegationId: encodePlanHolder('lead', 'x') },
    ])
    expect(waiting.progressOf('m')).toEqual({ total: 1, done: 0, cancelled: 0, open: 1 })
  })

  it('survives a parent loop in a corrupt database', () => {
    const n = buildRequestNesting([sub('a', 'todo', 'b'), sub('b', 'todo', 'a')])
    expect(n.subtasksOf('a')).toEqual([])
  })
})

describe('what the lanes draw', () => {
  it('nests sub-tasks, but keeps the one that needs a person', () => {
    const stuck = sub('stuck', 'blocked', 'm', { reason: 'failed', failedRuns: 1 })
    const tasks = [
      main,
      sub('a', 'in_progress'),
      sub('b', 'done'),
      stuck,
      { id: 'x', status: 'todo' },
    ]
    const n = buildRequestNesting(tasks)
    expect(tasksOnTheirOwn(tasks, n).map((t) => t.id)).toEqual(['m', 'stuck', 'x'])
  })

  it('keeps a sub-task whose main task a filter left out', () => {
    const tasks = [main, sub('a', 'in_progress')]
    const n = buildRequestNesting(tasks)
    expect(tasksOnTheirOwn([tasks[1]!], n).map((t) => t.id)).toEqual(['a'])
  })

  it('never hides open work under a request that says it is finished', () => {
    const closed = { ...main, status: 'done' }
    const tasks = [closed, sub('a', 'done'), sub('b', 'in_progress')]
    const n = buildRequestNesting(tasks)
    expect(tasksOnTheirOwn(tasks, n).map((t) => t.id)).toEqual(['m', 'b'])
  })

  it('leaves a board with no requests as it was', () => {
    const tasks = [{ id: 'x', status: 'todo' }, sub('y', 'todo', 'x')]
    expect(tasksOnTheirOwn(tasks, buildRequestNesting(tasks))).toEqual(tasks)
  })
})

describe('labels and cost', () => {
  it('names the request by its id, else its words', () => {
    expect(requestLabel(main)).toBe('For CLB-1')
    expect(requestLabel({ title: 'Build it' })).toBe('For “Build it”')
    expect(requestLabel({})).toBe('For a request')
  })

  it('adds up what its work cost, and says if any is an estimate', () => {
    const cost = requestCost([
      { id: 'a', status: 'done', runCost: { usd: 0.5, estimated: false } },
      { id: 'b', status: 'done', runCost: { usd: 0.25, estimated: true } },
      { id: 'c', status: 'todo', runCost: { usd: null, estimated: false } },
    ] as never)
    expect(cost).toEqual({ usd: 0.75, estimated: true })
    expect(requestCost([])).toEqual({ usd: null, estimated: false })
  })
})
