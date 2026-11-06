// The order work waits in, as SQL over `tasks`: tasks that already ran and came back,
// then aged priority, then oldest first. A task never moves up for being edited.
// One definition, because the ready list and the wake list must agree: the two feed
// the same agents, and whichever fires first takes the agent's session.

import {
  MAX_TASK_PRIORITY,
  MIN_TASK_PRIORITY,
  PAUSED_RUN_CLASS,
  READY_AGING_CEILING,
  READY_AGING_STEP_MS,
} from '@clawboo/board-core'
import { asc, desc, sql, type SQL } from 'drizzle-orm'

import { tasks } from '../schema'

export function readyOrder(now: number): SQL[] {
  const ranBefore = sql`EXISTS (SELECT 1 FROM execution_processes e WHERE e.task_id = ${tasks.id} AND (e.status != 'cancelled' OR e.error_class = ${PAUSED_RUN_CLASS}))`
  const clamped = sql`max(${MIN_TASK_PRIORITY}, min(${MAX_TASK_PRIORITY}, ${tasks.priority}))`
  // CAST: a bound number is a float here, and the division must be a whole count.
  const stepsWaited = sql`max(0, CAST((${now} - ${tasks.createdAt}) / ${READY_AGING_STEP_MS} AS INTEGER))`
  return [
    desc(ranBefore),
    desc(sql`max(${clamped}, min(${READY_AGING_CEILING}, ${clamped} + ${stepsWaited}))`),
    asc(tasks.createdAt),
    asc(tasks.id),
  ]
}
