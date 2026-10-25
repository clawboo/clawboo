import { describe, expect, it } from 'vitest'

import {
  TASK_SECTIONS,
  groupTeamTasks,
  inRoom,
  shortWhen,
  taskSectionOf,
  tasksInRoom,
} from '../teamTasks'

const task = (
  status: string,
  updatedAt = 0,
  attention?: { reason: string; failedRuns: number } | null,
) => ({ status, updatedAt, attention: attention as never })

describe('team tasks grouping', () => {
  it('puts a task that waits on a person in Needs you, whatever its status', () => {
    expect(taskSectionOf(task('todo', 0, { reason: 'failed', failedRuns: 2 }))).toBe('needs_you')
    expect(taskSectionOf(task('todo', 0, { reason: 'unassigned', failedRuns: 0 }))).toBe(
      'needs_you',
    )
    // A blocked task needs a person even when the server sent no verdict.
    expect(taskSectionOf(task('blocked'))).toBe('needs_you')
  })

  it('sorts the rest by status', () => {
    expect(taskSectionOf(task('in_progress'))).toBe('in_progress')
    expect(taskSectionOf(task('in_review'))).toBe('in_progress')
    expect(taskSectionOf(task('todo'))).toBe('todo')
    expect(taskSectionOf(task('backlog'))).toBe('todo')
    expect(taskSectionOf(task('done'))).toBe('done')
    expect(taskSectionOf(task('cancelled'))).toBe('cancelled')
    expect(taskSectionOf(task('something_new'))).toBe('todo')
  })

  it('keeps every section, each newest first', () => {
    const groups = groupTeamTasks([task('todo', 1), task('todo', 3), task('done', 2)])
    expect(Object.keys(groups).sort()).toEqual(TASK_SECTIONS.map((s) => s.id).sort())
    expect(groups.todo.map((t) => t.updatedAt)).toEqual([3, 1])
    expect(groups.done).toHaveLength(1)
    expect(groups.needs_you).toHaveLength(0)
  })

  it('folds Done and Cancelled by default', () => {
    const closed = TASK_SECTIONS.filter((s) => !s.defaultOpen).map((s) => s.id)
    expect(closed).toEqual(['done', 'cancelled'])
  })

  it('formats the row date', () => {
    const now = Date.UTC(2026, 9, 22, 12)
    expect(shortWhen(now - 10_000, now)).toBe('now')
    expect(shortWhen(now - 5 * 60_000, now)).toBe('5m')
    expect(shortWhen(now - 3 * 3_600_000, now)).toBe('3h')
    expect(shortWhen(now - 3 * 86_400_000, now)).toMatch(/19/)
  })
})

describe('team tasks by chat room', () => {
  const tasks = [
    { id: 'legacy', status: 'todo', updatedAt: 1 },
    { id: 'default', status: 'todo', updatedAt: 2, roomId: null },
    { id: 'design', status: 'todo', updatedAt: 3, roomId: 'room-design' },
    { id: 'launch', status: 'done', updatedAt: 4, roomId: 'room-launch' },
  ]

  it('the team group chat shows the tasks with no room, old ones included', () => {
    expect(tasksInRoom(tasks, null).map((t) => t.id)).toEqual(['legacy', 'default'])
  })

  it('a room shows only its own tasks', () => {
    expect(tasksInRoom(tasks, 'room-design').map((t) => t.id)).toEqual(['design'])
    expect(tasksInRoom(tasks, 'room-launch').map((t) => t.id)).toEqual(['launch'])
    expect(tasksInRoom(tasks, 'room-gone')).toEqual([])
  })

  it('inRoom treats an unknown room as the default room', () => {
    expect(inRoom({}, null)).toBe(true)
    expect(inRoom({ roomId: undefined }, 'room-design')).toBe(false)
    expect(inRoom({ roomId: 'room-design' }, null)).toBe(false)
  })
})
