// ─── A task is created once ─────────────────────────────────────────────────
// Two checks, run inside the create's own BEGIN IMMEDIATE transaction, so two
// writers racing the same create cannot both miss them.
//
// The key: the same idempotency key returns the same task. A caller's own key holds
// for good. A key the server made up is only a guess that two creates are the same
// one, so it holds for the window and never over a blocked task, which is what a
// retry is for.
//
// The title: an agent's create returns an open task with the same words, under the
// same parent, from the last 48 hours. A person's own creates skip this. Blocked
// tasks are not open here: a lead's retry of a failed task, or its hand-off of that
// task to another teammate, must make a new one. That covers work that failed the
// team's check too, which sits in Blocked. So is a task in To do that will not start
// by itself (a person's Stop, or a run of failures): a hand-off is how it starts again.
// A hand-off has a target, so it matches only a task someone is on and that will run:
// a card nobody holds, or one parked in Backlog, would answer it with work nothing is
// doing. A turn's own tasks never stand in for each other, since a turn that asks two
// teammates the same thing means both.

import { createHash } from 'node:crypto'

import {
  HAND_OFF_TITLE_CHARS,
  ledgerWillAutoFire,
  normalizeTaskTitle,
  parseWaitingOn,
  waitsOnOtherWork,
} from '@clawboo/board-core'
import { and, asc, eq, gt, inArray, isNotNull, isNull, like, or } from 'drizzle-orm'

import { executionProcesses, taskCreateKeys, tasks, type DbTask } from '../schema'
import type { BoardTx } from './contention'

/** How long a same-title match and a server-made key hold. */
export const SAME_TASK_WINDOW_MS = 48 * 60 * 60_000

/** The statuses the same-title check treats as open. */
const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review']

export interface TaskCreateKey {
  key: string
  /** The server made it up from the run and the title; no caller named it. */
  derived?: boolean
  /** A wider guess than that: the key speaks for a whole team, not one task's run, so
   *  a finished or cancelled original is someone else's earlier work, not this create. */
  openOnly?: boolean
}

export type DedupedBy = 'key' | 'title'

/** A created task. A create that found its task already there returns that one,
 *  marked, and wrote nothing. */
export type CreatedTask = DbTask & { deduplicated?: true; deduplicatedBy?: DedupedBy }

/** What the checks read of a create, with its team and room already inherited. */
export interface CreateIdentity {
  title: string
  description?: string | null
  parentTaskId?: string | null
  teamId?: string | null
  roomId?: string | null
  createKey?: TaskCreateKey | null
  agentCreated?: boolean
  /** The create has a target: only a task someone is on, and that will run, can stand
   *  in for it. */
  titleMatchNeedsOwner?: boolean
  /** Tasks from this turn do not stand in: it means each of them (see `HandOffInput`). */
  titleMatchExceptTurn?: string | null
}

/**
 * A key the server makes up for a create nobody named a key for: who is creating
 * (`scope`) and what, in the words as the same-title check compares them. The text
 * goes in hashed, so a long ask does not become a long index entry.
 */
export function deriveCreateKey(scope: readonly string[], text: string): TaskCreateKey {
  const words = createHash('sha256').update(normalizeTaskTitle(text)).digest('hex')
  return { key: [...scope, words].join(':'), derived: true }
}

export function rememberCreateKey(
  tx: BoardTx,
  key: TaskCreateKey,
  taskId: string,
  now: number,
): void {
  tx.insert(taskCreateKeys)
    .values({ key: key.key, taskId, derived: key.derived ? 1 : 0, createdAt: now })
    .run()
}

function byKey(tx: BoardTx, key: TaskCreateKey, now: number): DbTask | null {
  const row = tx.select().from(taskCreateKeys).where(eq(taskCreateKeys.key, key.key)).get()
  if (!row) return null
  const task = tx.select().from(tasks).where(eq(tasks.id, row.taskId)).get() as DbTask | undefined
  const stale =
    row.derived === 1 &&
    (row.createdAt <= now - SAME_TASK_WINDOW_MS ||
      task?.status === 'blocked' ||
      (key.openOnly === true && (task?.status === 'done' || task?.status === 'cancelled')))
  if (task && !task.dropped && !stale) return task
  // Spent: the next create under this key is a new one.
  tx.delete(taskCreateKeys).where(eq(taskCreateKeys.key, key.key)).run()
  return null
}

/** The whole ask a task's title stands for. The engine keeps a long hand-off's full
 *  text as its description and cuts the title, so such a title alone does not say
 *  two asks are the same. */
function askOf(task: { title: string; description?: string | null }): string {
  const cut =
    task.title.length >= HAND_OFF_TITLE_CHARS && !!task.description?.startsWith(task.title)
  return normalizeTaskTitle(cut ? (task.description as string) : task.title)
}

function bySameTitle(tx: BoardTx, input: CreateIdentity, now: number): DbTask | null {
  const wanted = askOf(input)
  // `idx_tasks_parent_dropped_created` serves this: the same parent, not dropped,
  // recent. The words are compared here, since the stored title is not normalized.
  const candidates = tx
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      sourceDelegationId: tasks.sourceDelegationId,
      waitingOn: tasks.waitingOn,
    })
    .from(tasks)
    .where(
      and(
        input.parentTaskId
          ? eq(tasks.parentTaskId, input.parentTaskId)
          : isNull(tasks.parentTaskId),
        eq(tasks.dropped, 0),
        gt(tasks.createdAt, now - SAME_TASK_WINDOW_MS),
        input.teamId ? eq(tasks.teamId, input.teamId) : isNull(tasks.teamId),
        input.roomId ? eq(tasks.roomId, input.roomId) : isNull(tasks.roomId),
        // Nothing starts a Backlog card by itself, so a hand-off it answered would wait.
        inArray(
          tasks.status,
          input.titleMatchNeedsOwner
            ? [...OPEN_STATUSES.filter((s) => s !== 'backlog'), 'blocked']
            : [...OPEN_STATUSES, 'blocked'],
        ),
        ...(input.titleMatchNeedsOwner
          ? [or(isNotNull(tasks.assigneeAgentId), like(tasks.sourceDelegationId, '%:agent:%'))]
          : []),
      ),
    )
    .orderBy(asc(tasks.createdAt))
    .all()
  const ownTurn = input.titleMatchExceptTurn ? `${input.titleMatchExceptTurn}:` : null
  const match = candidates.find(
    (c) =>
      askOf(c) === wanted &&
      !(ownTurn && c.sourceDelegationId?.startsWith(ownTurn)) &&
      (c.status !== 'todo' || startsByItself(tx, c.id)) &&
      // Blocked is open only while it waits on other work: the board moves it on by
      // itself, and its result still comes. Any other wait needs someone to act.
      (c.status !== 'blocked' || waitsOnOtherWork(parseWaitingOn(c.waitingOn))),
  )
  if (!match) return null
  return tx.select().from(tasks).where(eq(tasks.id, match.id)).get() as DbTask
}

/** Will the pump run this To do task on its own, now or when a wait ends? The same
 *  rule the pump reads. */
function startsByItself(tx: BoardTx, taskId: string): boolean {
  const runs = tx
    .select()
    .from(executionProcesses)
    .where(eq(executionProcesses.taskId, taskId))
    .orderBy(asc(executionProcesses.createdAt))
    .all()
  return ledgerWillAutoFire(runs)
}

/** The task this create is a repeat of, marked, or null when it is a new one. */
export function existingTaskForCreate(
  tx: BoardTx,
  input: CreateIdentity,
  now: number,
): CreatedTask | null {
  const key = input.createKey ?? null
  if (key) {
    const task = byKey(tx, key, now)
    if (task) return { ...task, deduplicated: true, deduplicatedBy: 'key' }
  }
  if (input.agentCreated) {
    const task = bySameTitle(tx, input, now)
    if (task) {
      // So this key's own retry finds it even once the task has closed.
      if (key) rememberCreateKey(tx, key, task.id, now)
      return { ...task, deduplicated: true, deduplicatedBy: 'title' }
    }
  }
  return null
}
