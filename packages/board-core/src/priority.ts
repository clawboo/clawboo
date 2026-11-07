// ─── Task priority ──────────────────────────────────────────────────────────
// A task's priority is an integer column, and the ready-pump serves the higher
// number first. Left unbounded, any writer could jump the queue with a large
// number, an agent's `create_task` included. So the integer is read and written
// through four named levels: a write is clamped to them, and a value stored
// before the clamp reads as the nearest one. 0, what every task has always had
// by default, is `normal`.
//
// Import-free, like the rest of board-core: it ships into the Vite SPA.

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'

/** Highest first: the order the ready-pump serves them in. */
export const TASK_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'normal', 'low']

/** The stored value of each level. */
export const TASK_PRIORITY_VALUE: Readonly<Record<TaskPriority, number>> = {
  urgent: 2,
  high: 1,
  normal: 0,
  low: -1,
}

/** What a person reads for each level. */
export const TASK_PRIORITY_LABEL: Readonly<Record<TaskPriority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

export const MAX_TASK_PRIORITY = TASK_PRIORITY_VALUE.urgent
export const MIN_TASK_PRIORITY = TASK_PRIORITY_VALUE.low

/** The value to store for a requested priority: rounded, then held to the four
 *  levels. Anything that is not a finite number is `normal`. */
export function clampTaskPriority(value: number): number {
  if (!Number.isFinite(value)) return TASK_PRIORITY_VALUE.normal
  return Math.min(MAX_TASK_PRIORITY, Math.max(MIN_TASK_PRIORITY, Math.round(value)))
}

/**
 * The value to store for a priority an agent asked for. Urgent is a person's call,
 * so an agent's write stops at High: Urgent goes to the front of every queue, and
 * an agent marking its own work urgent would push a person's aside. The one place
 * this rule lives.
 */
export function clampAgentTaskPriority(value: number): number {
  return Math.min(TASK_PRIORITY_VALUE.high, clampTaskPriority(value))
}

/** The level a stored value reads as. */
export function taskPriorityOf(value: number | null | undefined): TaskPriority {
  const v = clampTaskPriority(value ?? TASK_PRIORITY_VALUE.normal)
  if (v >= TASK_PRIORITY_VALUE.urgent) return 'urgent'
  if (v === TASK_PRIORITY_VALUE.high) return 'high'
  if (v === TASK_PRIORITY_VALUE.normal) return 'normal'
  return 'low'
}

/**
 * How long a task waits in To do to read one level higher in the ready list, so
 * low-priority work gets through a steady stream of newer work: Normal reads as High
 * after one step and Low after two.
 */
export const READY_AGING_STEP_MS = 4 * 60 * 60_000

/**
 * The highest level waiting can reach. One below Urgent, because a person's Urgent
 * has to mean something: otherwise every overnight Normal task would tie a fresh
 * Urgent and win on age.
 */
export const READY_AGING_CEILING = TASK_PRIORITY_VALUE.high

/**
 * The level a task reads as after waiting since it was created: its stored level,
 * clamped, plus a level per `READY_AGING_STEP_MS`, up to `READY_AGING_CEILING`. A task
 * stored above that keeps its level. Counted from creation, so an edit moves nothing.
 * `getReadyTasks` applies the same rule in SQL.
 */
export function agedTaskPriority(
  task: { priority: number; createdAt: number },
  now: number,
): number {
  const stored = clampTaskPriority(task.priority)
  const steps = Math.max(0, Math.floor((now - task.createdAt) / READY_AGING_STEP_MS))
  return Math.max(stored, Math.min(READY_AGING_CEILING, stored + steps))
}
