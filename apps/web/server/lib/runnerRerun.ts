// A person's Retry or Assign on a task the task runner ran.
//
// The runner (POST /api/runtimes/:id/run, and agent Routine fires) gives a run a
// worktree and verifies its changes. Team chat does neither. So a task the runner
// ran goes back through the runner, with the inputs it saved on the task when it
// claimed it (`runner_inputs`). A task the runner never ran has none, and the
// board hands it to team chat as before. Which way a task goes is decided in
// ./runnerRoute.

import { delegationTargetOf } from '@clawboo/board-core'
import {
  addComment,
  getReadyTasks,
  getTask,
  isLedgerAutoFireable,
  listExecutions,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { runTaskOnRuntime, type RunTaskResult } from './executorRunner'
import { emitEvent } from './obs'
import { adapterFactoryFor } from './runtimes'
import { getDescriptor } from './runtimes/descriptor'
import { runtimeKeyEnv } from './runtimes/runKeyEnv'
import { runnerRerunFor, type RunnerRerun } from './runnerRoute'

export { runnerRerunFor, type RunnerRerun } from './runnerRoute'

const log = createLogger('runner-rerun')

/**
 * Reruns started from here that have not settled, by task. A run can wait for a
 * free run slot (see runSlots), then up to the home mutex's timeout behind another
 * run on the same agent, before it claims the task, so a second Retry, or an
 * Assign to someone else, would otherwise
 * queue a second run that claims the task later. Starting a rerun stops the one
 * still waiting; a claimed run cannot be replaced, because the board refuses a
 * Retry or an Assign while the task is in progress.
 */
const waiting = new Map<string, AbortController>()

/** Stop a rerun of this task that has not settled yet. */
export function cancelRunnerRerun(taskId: string): void {
  waiting.get(taskId)?.abort()
  waiting.delete(taskId)
}

/** Why a rerun did not start, in words for the task's trail. */
function refusalWords(reason: Extract<RunTaskResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'budget_paused':
      return 'a budget it counts against is paused at its hard cap'
    case 'budget_held':
      return 'a budget it counts against is close to its hard cap, and runs already going have set aside the rest of it'
    case 'too_deep':
      return 'it sits deeper in its task tree than a run may start'
    case 'connected_substrate':
      return 'that runtime does not run through the task runner'
    case 'workspace_unavailable':
      return 'its worktree could not be set up'
    default:
      return reason
  }
}

/**
 * A rerun that never started leaves the task in To do with nothing coming for
 * it. Put it in Needs you with the reason, so the card says what happened. A task
 * that moved on meanwhile (a person, another run) is left alone.
 */
function parkUnstarted(db: ClawbooDb, taskId: string, runtime: string, why: string): void {
  try {
    if (getTask(db, taskId)?.status !== 'todo') return
    const moved = updateStatus(db, taskId, 'blocked')
    if (!moved.ok) return
    // The event log is what live views follow; the status write reaches only
    // the in-process bus.
    emitEvent(db, {
      kind: 'status_changed',
      taskId,
      teamId: moved.task?.teamId ?? null,
      data: { to: 'blocked', reason: 'rerun_not_started' },
    })
    addComment(
      db,
      taskId,
      `The rerun on ${getDescriptor(runtime as RunnerRerun['runtime']).name} did not start: ${why}.`,
      'system',
    )
  } catch (err) {
    log.error({ err, taskId }, 'could not record a rerun that did not start')
  }
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
  const { taskId } = input
  const { runtime, inputs } = input.rerun
  cancelRunnerRerun(taskId)
  const controller = new AbortController()
  waiting.set(taskId, controller)
  const settle = (): void => {
    if (waiting.get(taskId) === controller) waiting.delete(taskId)
  }
  const apiKeyEnv = runtimeKeyEnv(runtime)
  runTaskOnRuntime({
    db,
    makeAdapter: adapterFactoryFor(runtime),
    taskId,
    assigneeAgentId: input.assigneeAgentId,
    repoPath: inputs.repoPath,
    ...(inputs.kind ? { kind: inputs.kind } : {}),
    // A model names one runtime's model: on another runtime the agent's own
    // model applies.
    model: runtime === inputs.runtime ? inputs.model : null,
    mcpBaseUrl: input.mcpBaseUrl,
    ...(inputs.maxNodeCents != null ? { maxNodeCents: inputs.maxNodeCents } : {}),
    ...(Object.keys(apiKeyEnv).length > 0 ? { apiKeyEnv } : {}),
    abortSignal: controller.signal,
  })
    .then((result) => {
      settle()
      log.debug({ taskId, runtime, result }, 'runner rerun')
      // A lost claim means the task is someone else's now; not_found means it
      // is gone. Neither is a rerun stuck in To do.
      if (!result.ok && result.reason !== 'conflict' && result.reason !== 'not_found') {
        parkUnstarted(db, taskId, runtime, refusalWords(result.reason))
      }
    })
    .catch((err: unknown) => {
      settle()
      log.error({ err, taskId, runtime }, 'runner rerun failed')
      // Stopped on purpose by a newer rerun of the same task: that one owns it.
      if (controller.signal.aborted) return
      parkUnstarted(db, taskId, runtime, err instanceof Error ? err.message : String(err))
    })
}

/**
 * The automatic re-fire for task-runner tasks. A task bound to an agent goes
 * back to To do when its run fails, and is started again by itself until
 * MAX_AUTO_FIRES runs in a row have failed. Team chat's pump does that for every
 * other task and skips these (see the server board client), so this does it for
 * them, through the runner, on the same pump interval.
 */
export function pumpRunnerReruns(db: ClawbooDb, mcpBaseUrl: string | null): void {
  for (const task of getReadyTasks(db)) {
    if (!task.runnerInputs || waiting.has(task.id)) continue
    const agentId = delegationTargetOf(task.sourceDelegationId)
    if (!agentId) continue
    if (!isLedgerAutoFireable(listExecutions(db, task.id))) continue
    const rerun = runnerRerunFor(db, task, agentId)
    if (!rerun) continue
    requestRunnerRerun(db, { taskId: task.id, assigneeAgentId: agentId, rerun, mcpBaseUrl })
  }
}

/** Test seam: forget every waiting rerun. */
export function resetRunnerRerunsForTests(): void {
  for (const c of waiting.values()) c.abort()
  waiting.clear()
}
