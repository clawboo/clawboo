// What the task runner was given for a task, kept on the task.
//
// The runner (POST /api/runtimes/:id/run and agent Routine fires) runs a task
// with inputs the board never sees: the runtime, the repository its worktree
// branches from, the isolation kind and the model. Without them a person's Retry
// or Assign could only hand the task to team chat, which provisions no worktree
// and runs no verification. The runner records them when it claims the task, and
// those routes read them back to run it the same way again.
//
// A handoff pause (`keepForResume`) is deliberately not kept: a person who reruns
// a paused task wants it finished, and replaying the pause would park it again.

import { eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { tasks, type DbTask } from '../schema'
import { withWriteRetry } from './contention'

export interface TaskRunnerInputs {
  /** The runtime the run used, e.g. `claude-code`. */
  runtime: string
  /** The agent id the run was claimed for. */
  assigneeAgentId: string
  /** The repository the worktree branched from, when there was one. */
  repoPath: string | null
  /** The isolation kind (`code`, `research`, ...), or null for the default. */
  kind: string | null
  model: string | null
  maxNodeCents?: number
}

export function setTaskRunnerInputs(db: ClawbooDb, taskId: string, inputs: TaskRunnerInputs): void {
  withWriteRetry(() =>
    db
      .update(tasks)
      .set({ runnerInputs: JSON.stringify(inputs) })
      .where(eq(tasks.id, taskId))
      .run(),
  )
}

const optString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** The saved inputs, or null for a task the runner never ran (or a row that
 *  does not parse). */
export function readTaskRunnerInputs(
  task: Pick<DbTask, 'runnerInputs'> | null | undefined,
): TaskRunnerInputs | null {
  if (!task?.runnerInputs) return null
  let raw: unknown
  try {
    raw = JSON.parse(task.runnerInputs)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const runtime = optString(r['runtime'])
  const assigneeAgentId = optString(r['assigneeAgentId'])
  if (!runtime || !assigneeAgentId) return null
  return {
    runtime,
    assigneeAgentId,
    repoPath: optString(r['repoPath']),
    kind: optString(r['kind']),
    model: optString(r['model']),
    ...(typeof r['maxNodeCents'] === 'number' && Number.isFinite(r['maxNodeCents'])
      ? { maxNodeCents: r['maxNodeCents'] }
      : {}),
  }
}
