// Start a task a person asked for, whichever way it runs. Kept apart from the board
// routes because the wake pump starts tasks the same way.

import type { ClawbooDb } from '@clawboo/db'

import { cancelRunnerRerun, requestRunnerRerun } from './runnerRerun'
import type { RunnerRerun } from './runnerRoute'
import { requestTaskDispatch } from './teamChat/boardDispatch'

/**
 * Start a task a person asked for: through the task runner when `runner` is
 * given, else through its team's chat. Either way, a rerun of this task still
 * waiting to claim it is stopped first, so it cannot claim the task after the
 * run started here. `automatic`: no person is behind this start, so the run is
 * one its job counts, and its limit can refuse it.
 */
export function startTask(
  db: ClawbooDb,
  taskId: string,
  teamId: string | null,
  runner: { agentId: string; rerun: RunnerRerun } | null,
  mcpBaseUrl: string | null,
  opts: { automatic?: boolean } = {},
): void {
  cancelRunnerRerun(taskId)
  if (runner) {
    requestRunnerRerun(db, {
      taskId,
      assigneeAgentId: runner.agentId,
      rerun: runner.rerun,
      mcpBaseUrl,
      ...(opts.automatic ? { automaticStart: true } : {}),
    })
  } else if (teamId) {
    requestTaskDispatch(teamId, taskId, mcpBaseUrl, opts)
  }
}
