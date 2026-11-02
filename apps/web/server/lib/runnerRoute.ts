// Whether a task goes through the task runner or through team chat.
//
// Kept apart from runnerRerun.ts, which starts runs, so the team engine's board
// client can ask without loading the runner.

import { delegationTargetOf } from '@clawboo/board-core'
import {
  agents,
  readTaskRunnerInputs,
  type ClawbooDb,
  type DbTask,
  type TaskRunnerInputs,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { isOrchestratableRuntimeId, type NonOpenClawRuntimeId } from './runtimes/descriptor'

export interface RunnerRerun {
  runtime: NonOpenClawRuntimeId
  inputs: TaskRunnerInputs
}

/**
 * How to run this task through the runner for `agentId`, or null to leave it to
 * team chat.
 *
 * The agent's own runtime wins over the saved one, because an Assign can hand
 * the task to an agent on another runtime. A removed (archived) agent runs
 * nothing. An id with no agent row runs only when it is the saved runtime's own
 * id, which is the id a direct POST /api/runtimes/:id/run uses when it names no
 * agent; any other missing id is an agent that was deleted. An agent the runner
 * cannot run, such as one on OpenClaw, gets team chat.
 */
export function runnerRerunFor(
  db: ClawbooDb,
  task: Pick<DbTask, 'runnerInputs'>,
  agentId: string,
): RunnerRerun | null {
  const inputs = readTaskRunnerInputs(task)
  if (!inputs) return null
  const row = db
    .select({ runtime: agents.runtime, archivedAt: agents.archivedAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (row?.archivedAt != null) return null
  if (!row && agentId !== inputs.runtime) return null
  const runtime = row?.runtime ?? inputs.runtime
  return isOrchestratableRuntimeId(runtime) ? { runtime, inputs } : null
}

/**
 * Does this task run on the task runner when its bound agent picks it up? Then
 * team chat must not fire it: the runner owns its reruns (see lib/runnerRerun).
 */
export function runsOnTaskRunner(
  db: ClawbooDb,
  task: Pick<DbTask, 'runnerInputs' | 'sourceDelegationId'>,
): boolean {
  if (!task.runnerInputs) return false
  const agentId = delegationTargetOf(task.sourceDelegationId)
  return agentId !== null && runnerRerunFor(db, task, agentId) !== null
}
