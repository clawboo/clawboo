import { describe, expect, it } from 'vitest'

import type { BoardTask } from '@/lib/boardClient'
import type { RoutineOccurrences } from '@/lib/schedulesClient'

import { addDays, buildRange } from '../calendarModel'
import {
  FIND_LIMIT,
  findGroups,
  matchBoard,
  normalizeQuery,
  whereOf,
  type FindInput,
  type FindResult,
  type FindTaskResult,
} from '../findModel'

// Local-time constructors, so every assertion holds in any time zone. Oct 2026:
// the 12th is a Monday, so a Monday-first week holding the 14th is the 12th to 18th.
const at = (y: number, mo: number, d: number, h = 0): number => new Date(y, mo, d, h).getTime()
const NOW = at(2026, 9, 14, 12)
const WEEK = buildRange('week', NOW, 1)
const NEXT_WEEK = buildRange('week', addDays(NOW, 7), 1)
const LAST_WEEK = buildRange('week', addDays(NOW, -7), 1)

const AGENTS: Record<string, string> = { ada: 'Ada Lovelace', grace: 'Grace Hopper' }

const task = (id: string, title: string, extra: Partial<BoardTask> = {}): BoardTask =>
  ({ id, status: 'todo', title, createdAt: at(2026, 9, 13, 10), ...extra }) as BoardTask

const routine = (id: string) => ({ schedule: { id } }) as unknown as RoutineOccurrences

function input(tasks: BoardTask[], over: Partial<FindInput> = {}): FindInput {
  return {
    tasks,
    columnOf: (t) => t.status,
    ownerOf: (t) => t.assigneeAgentId ?? null,
    agentName: (id) => AGENTS[id] ?? null,
    routines: [],
    routineName: () => '',
    range: WEEK,
    showEarlier: true,
    now: NOW,
    ...over,
  }
}

const only = (results: FindResult[]): FindTaskResult => {
  expect(results).toHaveLength(1)
  const r = results[0]!
  if (r.kind !== 'task') throw new Error('expected a task result')
  return r
}

const ids = (results: readonly FindResult[]) => results.map((r) => r.id)

describe('normalizeQuery', () => {
  it('lowercases, drops accents, trims and collapses whitespace', () => {
    expect(normalizeQuery('  Café   RÉSUMÉ\t naïve ')).toBe('cafe resume naive')
  })
})

describe('matchBoard', () => {
  it('returns nothing for a blank query', () => {
    const tasks = [task('t1', 'Anything')]
    expect(matchBoard('', input(tasks))).toEqual([])
    expect(matchBoard('   ', input(tasks))).toEqual([])
  })

  it('ignores case and accents on both sides', () => {
    const tasks = [task('t1', 'Résumé review'), task('t2', 'Resume the import')]
    expect(ids(matchBoard('RESUME', input(tasks))).sort()).toEqual(['t1', 't2'])
    expect(ids(matchBoard('résumé', input(tasks))).sort()).toEqual(['t1', 't2'])
  })

  it('needs every token, but each may come from a different field', () => {
    const tasks = [task('t1', 'Write launch post', { assigneeAgentId: 'ada' })]
    const r = only(matchBoard('launch ada', input(tasks)))
    expect(r.score).toBe(45)
    expect(r.matchedOn).toBe('agent')
    expect(matchBoard('launch zebra', input(tasks))).toEqual([])
  })

  it('lets the weakest token decide the score and the field', () => {
    const tasks = [task('t1', 'Write launch post', { description: 'Include the pricing table' })]
    const viaDescription = only(matchBoard('write pricing', input(tasks)))
    expect(viaDescription.score).toBe(20)
    expect(viaDescription.matchedOn).toBe('description')

    // "write" starts the title (100), "post" starts a later word (80).
    const viaTitle = only(matchBoard('write post', input(tasks)))
    expect(viaTitle.score).toBe(80)
    expect(viaTitle.matchedOn).toBe('title')

    expect(only(matchBoard('aunch', input(tasks))).score).toBe(60)
  })

  it('matches the id only by prefix, and only for 4 or more characters', () => {
    const tasks = [task('ABCD1234-ffff', 'Untitled')]
    expect(matchBoard('abc', input(tasks))).toEqual([])
    expect(matchBoard('1234', input(tasks))).toEqual([])
    const r = only(matchBoard('abcd', input(tasks)))
    expect(r.score).toBe(30)
    expect(r.matchedOn).toBe('id')
  })

  it("matches the owner's name, scoring word starts above the middle", () => {
    const tasks = [
      task('t1', 'Ship it', { assigneeAgentId: 'ada' }),
      task('t2', 'Ship that', { assigneeAgentId: 'nobody' }),
    ]
    expect(only(matchBoard('love', input(tasks))).score).toBe(45)
    expect(only(matchBoard('ada', input(tasks))).score).toBe(45)
    const middle = only(matchBoard('velace', input(tasks)))
    expect(middle.score).toBe(35)
    expect(middle.matchedOn).toBe('agent')
  })

  it('reports the column, the placing instant and where the task sits', () => {
    const t = task('t1', 'Fix login', { status: 'in_progress' })
    const r = only(matchBoard('login', input([t])))
    expect(r).toMatchObject({
      kind: 'task',
      id: 't1',
      column: 'in_progress',
      at: at(2026, 9, 13, 10),
      where: 'here',
    })
  })

  it('lists FIND_LIMIT as eight', () => {
    expect(FIND_LIMIT).toBe(8)
  })
})

describe('whereOf', () => {
  const ctx = { range: WEEK, showEarlier: true, now: NOW }

  it('puts everything on screen in the undated view', () => {
    const old = task('t', 'Old', { status: 'done', completedAt: at(2025, 0, 1) })
    expect(whereOf(old, 'done', { ...ctx, range: null })).toBe('here')
  })

  it("follows today's row for Needs you", () => {
    const t = task('t', 'Stuck', { status: 'blocked', createdAt: at(2026, 0, 1) })
    expect(whereOf(t, 'needs_you', ctx)).toBe('here')
    expect(whereOf(t, 'needs_you', { ...ctx, range: NEXT_WEEK })).toBe('before')
    expect(whereOf(t, 'needs_you', { ...ctx, range: LAST_WEEK })).toBe('after')
  })

  it('is on screen when its day is in the range', () => {
    expect(whereOf(task('t', 'In', { createdAt: at(2026, 9, 18, 23) }), 'todo', ctx)).toBe('here')
  })

  it('keeps open work from before the range on screen only with an Earlier row', () => {
    const open = task('t', 'Open', { createdAt: at(2026, 9, 5) })
    expect(whereOf(open, 'todo', ctx)).toBe('here')
    expect(whereOf(open, 'todo', { ...ctx, showEarlier: false })).toBe('before')
  })

  it('sends finished work from before the range to Earlier', () => {
    const done = task('t', 'Done', { status: 'done', completedAt: at(2026, 9, 5) })
    expect(whereOf(done, 'done', ctx)).toBe('before')
  })

  it('sends work placed at or after the range end to Later', () => {
    expect(whereOf(task('t', 'Next', { createdAt: WEEK.end }), 'todo', ctx)).toBe('after')
  })

  it('places a task with no timestamps at now', () => {
    const bare = { id: 't', status: 'todo', title: 'Bare' } as BoardTask
    expect(whereOf(bare, 'todo', ctx)).toBe('here')
    expect(whereOf(bare, 'todo', { ...ctx, range: NEXT_WEEK, showEarlier: false })).toBe('before')
    expect(whereOf(bare, 'todo', { ...ctx, range: LAST_WEEK })).toBe('after')
  })
})

describe('sorting', () => {
  it('orders by score, then where, then newest first, then title', () => {
    const tasks = [
      task('later', 'Deploy later', { createdAt: at(2026, 9, 20) }),
      task('earlier', 'Deploy earlier', { status: 'done', completedAt: at(2026, 9, 1) }),
      task('old', 'Deploy old', { createdAt: at(2026, 9, 12, 9) }),
      task('new', 'Deploy new', { createdAt: at(2026, 9, 14, 9) }),
      task('bare', 'Deploy bare', { createdAt: undefined }),
      task('b', 'Deploy b', { createdAt: at(2026, 9, 13) }),
      task('a', 'Deploy a', { createdAt: at(2026, 9, 13) }),
      task('weak', 'Big deploy'),
    ]
    const results = matchBoard('deploy', input(tasks, { showEarlier: false }))
    // A bare task sits at now, on screen, but has no instant to sort by.
    expect(ids(results)).toEqual(['new', 'a', 'b', 'old', 'bare', 'earlier', 'later', 'weak'])
  })

  it('ranks a routine as on screen, after dated tasks of the same score', () => {
    const tasks = [
      task('next', 'Standup notes', { createdAt: WEEK.end }),
      task('here', 'Standup prep'),
    ]
    const results = matchBoard(
      'standup',
      input(tasks, { routines: [routine('r1')], routineName: () => 'Standup' }),
    )
    expect(ids(results)).toEqual(['here', 'r1', 'next'])
  })

  it('is deterministic for the same input', () => {
    const tasks = [task('x', 'Same'), task('y', 'Same'), task('z', 'Same')]
    const once = ids(matchBoard('same', input(tasks)))
    expect(ids(matchBoard('same', input([...tasks].reverse())))).toEqual(once)
  })
})

describe('routines', () => {
  it('matches on the name with the title scale and lists a routine once', () => {
    const names: Record<string, string> = { r1: 'Daily standup', r2: 'Weekly report' }
    const results = matchBoard(
      'stand',
      input([], {
        routines: [routine('r1'), routine('r2'), routine('r1')],
        routineName: (r) => names[r.schedule.id] ?? '',
      }),
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      kind: 'routine',
      id: 'r1',
      name: 'Daily standup',
      score: 80,
    })
  })
})

describe('findGroups', () => {
  const results = matchBoard(
    'plan',
    input(
      [
        task('after', 'Plan later', { createdAt: WEEK.end }),
        task('here2', 'Plan two', { createdAt: at(2026, 9, 13) }),
        task('before', 'Plan old', { status: 'done', completedAt: at(2026, 9, 1) }),
        task('here1', 'Plan one', { createdAt: at(2026, 9, 14) }),
      ],
      { routines: [routine('r1')], routineName: () => 'Plan review' },
    ),
  )

  it('orders sections and keeps the order inside each', () => {
    const groups = findGroups(results, 'week')
    expect(groups.map((g) => [g.id, g.label, ids(g.items)])).toEqual([
      ['here', 'In this week', ['here1', 'here2']],
      ['before', 'Before this week', ['before']],
      ['after', 'After this week', ['after']],
      ['routines', 'Routines', ['r1']],
    ])
  })

  it('names the sections after the range shown, never "Earlier", which is a board row', () => {
    const labels = (scope: 'day' | 'month') => findGroups(results, scope).map((g) => g.label)
    expect(labels('day')).toEqual(['Today', 'Before today', 'After today', 'Routines'])
    expect(labels('month')).toEqual([
      'In this month',
      'Before this month',
      'After this month',
      'Routines',
    ])
  })

  it('calls the first section Tasks in the All view and drops empty ones', () => {
    const tasksOnly = results.filter((r) => r.kind === 'task' && r.where === 'here')
    expect(findGroups(tasksOnly, 'all')).toEqual([{ id: 'here', label: 'Tasks', items: tasksOnly }])
    expect(findGroups([], 'week')).toEqual([])
  })
})
