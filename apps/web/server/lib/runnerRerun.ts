// A person's Retry or Assign on a task the task runner ran.
//
// The runner (POST /api/runtimes/:id/run, and agent Routine fires) gives a run a
// worktree and verifies its changes. Team chat does neither. So a task the runner
// ran goes back through the runner, with the inputs it saved on the task when it
// claimed it (`runner_inputs`). A task the runner never ran has none, and the
// board hands it to team chat as before.

import {
  agents,
  readTaskRunnerInputs,
  type ClawbooDb,
  type DbTask,
  type TaskRunnerInputs,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { eq } from 'drizzle-orm'

import { runTaskOnRuntime } from './executorRunner'
import { adapterFactoryFor } from './runtimes'
import { isOrchestratableRuntimeId, type NonOpenClawRuntimeId } from './runtimes/descriptor'
import { runtimeKeyEnv } from './runtimes/runKeyEnv'

const log = createLogger('runner-rerun')

export interface RunnerRerun {
  runtime: NonOpenClawRuntimeId
  inputs: TaskRunnerInputs
}

/**
 * How to run this task through the runner for `agentId`, or null to leave it to
 * team chat.
 *
 * The agent's own runtime wins over the saved one, because an Assign can hand
 * the task to an agent on another runtime. An id with no agent row (a direct
 * POST /api/runtimes/:id/run may name one) keeps the saved runtime. An agent the
 * runner cannot run, such as one on OpenClaw, gets team chat.
 */
export function runnerRerunFor(
  db: ClawbooDb,
  task: Pick<DbTask, 'runnerInputs'>,
  agentId: string,
): RunnerRerun | null {
  const inputs = readTaskRunnerInputs(task)
  if (!inputs) return null
  const row = db
    .select({ runtime: agents.runtime })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  const runtime = row?.runtime ?? inputs.runtime
  return isOrchestratableRuntimeId(runtime) ? { runtime, inputs } : null
}

/**
 * Start the run and return at once. The run can wait a long time behind another
 * one on the same agent, and an HTTP request must not hang on that; the board
 * shows the outcome on the card, as it does for a team-chat dispatch.
 */
export function requestRunnerRerun(
  db: ClawbooDb,
  input: {
    taskId: string
    assigneeAgentId: string
    rerun: RunnerRerun
    mcpBaseUrl: string | null
  },
): void {
  const { runtime, inputs } = input.rerun
  const apiKeyEnv = runtimeKeyEnv(runtime)
  runTaskOnRuntime({
    db,
    makeAdapter: adapterFactoryFor(runtime),
    taskId: input.taskId,
    assigneeAgentId: input.assigneeAgentId,
    repoPath: inputs.repoPath,
    ...(inputs.kind ? { kind: inputs.kind } : {}),
    // A model names one runtime's model: on another runtime the agent's own
    // model applies.
    model: runtime === inputs.runtime ? inputs.model : null,
    mcpBaseUrl: input.mcpBaseUrl,
    ...(inputs.keepForResume ? { keepForResume: true } : {}),
    ...(inputs.maxNodeCents != null ? { maxNodeCents: inputs.maxNodeCents } : {}),
    ...(Object.keys(apiKeyEnv).length > 0 ? { apiKeyEnv } : {}),
  })
    .then((result) => log.debug({ taskId: input.taskId, runtime, result }, 'runner rerun'))
    .catch((err: unknown) =>
      log.error({ err, taskId: input.taskId, runtime }, 'runner rerun failed'),
    )
}
