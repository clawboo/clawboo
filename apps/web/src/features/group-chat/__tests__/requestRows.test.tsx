// A person's request in the team chat: its rows in the Tasks card and its card in the
// timeline, each with the work filed under it.

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { buildRequestNesting } from '@/features/board/mainTasks'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { BoardTaskView } from '@/stores/board'

import { RequestCard } from '../RequestCard'
import { composerHint } from '../TeamTasksCard'
import { groupTeamTasks, taskRowsOf } from '../teamTasks'

afterEach(() => cleanup())

const task = (over: Partial<BoardTaskView>): BoardTaskView => ({
  id: 't',
  title: 'A task',
  status: 'todo',
  assigneeAgentId: null,
  parentTaskId: null,
  summary: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})
const main = task({ id: 'm', title: 'Build it', status: 'in_progress', isMainTask: true })
const running = task({ id: 'a', title: 'Form', status: 'in_progress', parentTaskId: 'm' })
const stuck = task({
  id: 'b',
  title: 'Deploy',
  status: 'blocked',
  parentTaskId: 'm',
  attention: { reason: 'failed', failedRuns: 1 },
})

describe('the Tasks card', () => {
  const tasks = [main, running, stuck, task({ id: 'x', title: 'Other' })]
  const nesting = buildRequestNesting(tasks)
  const groups = groupTeamTasks(tasks)

  it('draws a request with its work right under it', () => {
    const rows = taskRowsOf(groups.in_progress, 'in_progress', nesting)
    expect(rows.map((r) => [r.task.id, r.nested])).toEqual([
      ['m', false],
      ['a', true],
      ['b', true],
    ])
  })

  it('keeps a sub-task that needs a person in Needs you, naming its request', () => {
    const rows = taskRowsOf(groups.needs_you, 'needs_you', nesting)
    expect(rows.map((r) => [r.task.id, r.nested, r.request?.id])).toEqual([['b', false, 'm']])
  })

  it('never leaves open work only under a request that says it is finished', () => {
    const closed = { ...main, status: 'done' }
    const tasks2 = [closed, running]
    const n = buildRequestNesting(tasks2)
    const g = groupTeamTasks(tasks2)
    expect(taskRowsOf(g.in_progress, 'in_progress', n).map((r) => [r.task.id, r.nested])).toEqual([
      ['a', false],
    ])
    expect(taskRowsOf(g.in_progress, 'in_progress', n)[0]!.request?.id).toBe('m')
  })

  it('draws other tasks as it always did', () => {
    const rows = taskRowsOf(groups.todo, 'todo', nesting)
    expect(rows).toEqual([
      { task: expect.objectContaining({ id: 'x' }), nested: false, request: null },
    ])
  })
})

describe('the timeline card', () => {
  const card = (over: Partial<BoardTaskView>, open = 1, done = 0, subtasks = [running]) =>
    render(
      <ThemeProvider>
        <RequestCard
          task={{ ...main, identifier: 'CLB-1', ...over }}
          subtasks={subtasks}
          progress={{ total: open + done, done, cancelled: 0, open }}
          teamId="team-1"
        />
      </ThemeProvider>,
    )

  it('holds its progress and each sub-task’s own card', () => {
    card({})
    const el = screen.getByTestId('request-card')
    expect(el).toHaveTextContent('Build it')
    expect(within(el).getByTestId('request-card-id')).toHaveTextContent('CLB-1')
    expect(within(el).getByTestId('request-card-progress')).toHaveTextContent('0 of 1 done')
    expect(within(el).getAllByTestId('board-task-card')).toHaveLength(1)
  })

  it('says it is summing up when the work is in', () => {
    card({}, 0, 1)
    expect(screen.getByTestId('request-card')).toHaveTextContent('Summing up')
  })

  it('says Paused while a pause covers it, not Working', () => {
    card({ pause: { kind: 'team', id: 'T', name: 'Team' } } as Partial<BoardTaskView>)
    const pill = within(screen.getByTestId('request-card')).getAllByText(/^(Paused|Working)$/)[0]
    expect(pill).toHaveTextContent('Paused')
  })

  it('says it needs you when a sub-task does', () => {
    card({}, 1, 0, [
      { ...running, attention: { reason: 'failed', failedRuns: 1 } } as BoardTaskView,
    ])
    expect(within(screen.getByTestId('request-card')).getAllByText('Needs you')).toHaveLength(1)
  })

  it('says Done when it is', () => {
    card({ status: 'done' }, 0, 1)
    expect(screen.getByTestId('request-card')).toHaveTextContent('Done')
  })
})

describe('the Tasks card’s composer on a task', () => {
  it('says a pause holds it, whatever the task’s status would say', () => {
    const paused = { pause: { kind: 'team', id: 'T', name: 'Team' } } as Partial<BoardTaskView>
    const said = 'This is paused. Worker starts on your comment after the resume.'
    expect(composerHint({ ...running, ...paused }, 'Worker', 'live', true)).toBe(said)
    expect(composerHint({ ...running, ...paused, status: 'todo' }, 'Worker', 'live', true)).toBe(
      said,
    )
    expect(composerHint({ ...main, ...paused }, 'Lead', 'live', true)).toMatch(/after the resume/)
    expect(composerHint({ ...running, ...paused, status: 'done' }, 'Worker', 'live', true)).toMatch(
      /finished/,
    )
  })

  it('says the check goes first on work being checked', () => {
    expect(composerHint({ ...running, status: 'in_review' }, 'Worker', 'live', true)).toBe(
      'Worker reads this after the check.',
    )
  })
})

describe('the Tasks card’s composer on a request', () => {
  it('says the lead reads it, not that a run gets it now', () => {
    expect(composerHint(main, 'Lead', 'live', true)).toMatch(/Lead reads this/)
    expect(composerHint({ ...main, status: 'done' }, 'Lead', 'live', true)).not.toMatch(/follow-up/)
    expect(composerHint(running, 'Worker', 'live', true)).toBe(
      'Worker gets this now, before its next step.',
    )
  })
})
