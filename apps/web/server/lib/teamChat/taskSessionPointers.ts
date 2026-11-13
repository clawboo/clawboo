// Per-task resume pointers, as stored: read one, clear a task's, and sweep the
// ones nothing will read again. The keys and the pointer's shape are in
// ./nativeTeamSession; serverDeliver reads and writes them around a task run.

import { createHash } from 'node:crypto'

import { delegationTargetOf } from '@clawboo/board-core'
import { getSetting, getTask, setSetting, settings, type ClawbooDb } from '@clawboo/db'
import { inArray, like } from 'drizzle-orm'

import {
  parseTaskSessionPointer,
  TASK_SESSION_KEYS_LIKE,
  taskSessionKeysForTaskLike,
  taskSessionSettingKey,
  type TaskSessionPointer,
} from './nativeTeamSession'

/** A hash of a task's title and description: what a resumed run compares to
 *  tell whether either changed since its session last saw them. */
export function ticketHashOf(task: { title: string; description?: string | null }): string {
  return createHash('sha256')
    .update(`${task.title}\u0000${task.description ?? ''}`)
    .digest('hex')
    .slice(0, 32)
}

/** Whether a pointer on `task` can still be read: the task is there, not
 *  dropped, and neither finished nor cancelled. */
export function taskTakesPointers(
  task: { status: string; dropped?: number | boolean | null } | null | undefined,
): boolean {
  return !!task && !task.dropped && task.status !== 'done' && task.status !== 'cancelled'
}

/** Whether `agentId`'s run may still write its pointer on `task` as it ends:
 *  the task takes pointers, and it is not bound to another agent. A task given
 *  to someone else has had the old agent's pointer cleared while its stopped
 *  run was still ending. */
export function taskPointerWantedFor(
  task:
    | {
        status: string
        dropped?: number | boolean | null
        sourceDelegationId?: string | null
      }
    | null
    | undefined,
  agentId: string,
): boolean {
  if (!task || !taskTakesPointers(task)) return false
  const bound = delegationTargetOf(task.sourceDelegationId)
  return bound === null || bound === agentId
}

/** `agentId`'s pointer for `taskId`, or null when it has none. */
export function readTaskSessionPointer(
  db: ClawbooDb,
  agentId: string,
  teamId: string,
  taskId: string,
): TaskSessionPointer | null {
  return parseTaskSessionPointer(getSetting(db, taskSessionSettingKey(agentId, teamId, taskId)))
}

/** Forget every agent's session on `taskId`: the task finished, was cancelled,
 *  or was given to someone else, who starts fresh. */
export function clearTaskSessionPointers(db: ClawbooDb, taskId: string): void {
  db.delete(settings)
    .where(like(settings.key, taskSessionKeysForTaskLike(taskId)))
    .run()
}

/**
 * Delete the pointers nothing will read again: cleared or malformed ones, and
 * ones whose task is gone, dropped, finished or cancelled. A task's own events clear its
 * pointers as they happen; this catches what they cannot see, such as a task
 * an MCP stdio server cancelled from another process, or a server that stopped
 * between a task finishing and its clear. Run at boot. Returns how many went.
 */
export function sweepTaskSessionPointers(db: ClawbooDb): number {
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, TASK_SESSION_KEYS_LIKE))
    .all()
  const stale: string[] = []
  for (const row of rows) {
    // native-team-session:<agentId>:<teamId>:task:<taskId>; ids hold no colon.
    const taskId = row.key.split(':task:')[1] ?? ''
    const task = taskId ? getTask(db, taskId) : null
    if (!parseTaskSessionPointer(row.value) || !taskTakesPointers(task)) stale.push(row.key)
  }
  const CHUNK = 500
  for (let i = 0; i < stale.length; i += CHUNK)
    db.delete(settings)
      .where(inArray(settings.key, stale.slice(i, i + CHUNK)))
      .run()
  return stale.length
}

/** Set once the Claude Code task pointers from before task folders are gone. */
export const TASK_FOLDER_POINTERS_CLEARED_KEY = 'task-folders:claude-code-pointers-cleared'

/**
 * Claude Code files a session under the folder it ran in, and resumes only from
 * there. Task runs used to start in their team's folder and now start in the
 * task's own folder, so a Claude Code task pointer saved before that names a
 * session the next run cannot resume, and that run would fail. Drop those
 * pointers once, so the next run starts fresh from its ticket. Other runtimes
 * keep theirs: their sessions do not depend on the folder. Run at boot. Returns
 * how many went.
 */
export function clearClaudeCodeTaskPointersOnce(db: ClawbooDb): number {
  if (getSetting(db, TASK_FOLDER_POINTERS_CLEARED_KEY)) return 0
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, TASK_SESSION_KEYS_LIKE))
    .all()
  const stale = rows
    .filter((row) => parseTaskSessionPointer(row.value)?.runtime === 'claude-code')
    .map((row) => row.key)
  const CHUNK = 500
  for (let i = 0; i < stale.length; i += CHUNK)
    db.delete(settings)
      .where(inArray(settings.key, stale.slice(i, i + CHUNK)))
      .run()
  setSetting(db, TASK_FOLDER_POINTERS_CLEARED_KEY, '1')
  return stale.length
}
