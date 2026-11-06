import { describe, expect, it } from 'vitest'

import {
  clampAgentTaskPriority,
  clampTaskPriority,
  MAX_TASK_PRIORITY,
  MIN_TASK_PRIORITY,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_VALUE,
  taskPriorityOf,
} from '../priority'

describe('task priority', () => {
  it('has four named levels over the integer, highest first, and 0 is normal', () => {
    expect(TASK_PRIORITIES).toEqual(['urgent', 'high', 'normal', 'low'])
    expect(TASK_PRIORITIES.map((p) => TASK_PRIORITY_VALUE[p])).toEqual([2, 1, 0, -1])
    expect(taskPriorityOf(0)).toBe('normal')
    expect(TASK_PRIORITY_LABEL[taskPriorityOf(0)]).toBe('Normal')
  })

  it('reads every stored value as a level, including ones written before the clamp', () => {
    expect(taskPriorityOf(2)).toBe('urgent')
    expect(taskPriorityOf(1)).toBe('high')
    expect(taskPriorityOf(-1)).toBe('low')
    expect(taskPriorityOf(1_000_000)).toBe('urgent')
    expect(taskPriorityOf(-50)).toBe('low')
    expect(taskPriorityOf(null)).toBe('normal')
    expect(taskPriorityOf(undefined)).toBe('normal')
  })

  it('clamps a write, so a large number cannot jump the queue past urgent', () => {
    expect(clampTaskPriority(999_999)).toBe(MAX_TASK_PRIORITY)
    expect(clampTaskPriority(-999_999)).toBe(MIN_TASK_PRIORITY)
    expect(clampTaskPriority(1)).toBe(1)
    expect(clampTaskPriority(1.6)).toBe(2)
    expect(clampTaskPriority(Number.NaN)).toBe(0)
    expect(clampTaskPriority(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('clampAgentTaskPriority', () => {
  it('holds an agent to High at most', () => {
    expect(clampAgentTaskPriority(TASK_PRIORITY_VALUE.urgent)).toBe(TASK_PRIORITY_VALUE.high)
    expect(clampAgentTaskPriority(99)).toBe(TASK_PRIORITY_VALUE.high)
  })

  it('leaves the levels below Urgent alone', () => {
    expect(clampAgentTaskPriority(TASK_PRIORITY_VALUE.high)).toBe(TASK_PRIORITY_VALUE.high)
    expect(clampAgentTaskPriority(TASK_PRIORITY_VALUE.normal)).toBe(TASK_PRIORITY_VALUE.normal)
    expect(clampAgentTaskPriority(TASK_PRIORITY_VALUE.low)).toBe(TASK_PRIORITY_VALUE.low)
    expect(clampAgentTaskPriority(-5)).toBe(TASK_PRIORITY_VALUE.low)
    expect(clampAgentTaskPriority(Number.NaN)).toBe(TASK_PRIORITY_VALUE.normal)
  })
})
