// A person's read state: which tasks changed since this reader last opened them.
//
// Unread means someone else changed or commented on the task since then. Three
// things make that exact rather than close:
//
//   · Changes are recorded by triggers (schemaBootstrap.ts), so no write path can
//     forget, including a future one or the stdio bin in another process. A seq
//     is a position in the whole board's history; two changes in one millisecond
//     are still two changes.
//   · A reader marks what the page SHOWED (`through`), never "now". A change that
//     landed after the page read the task stays unread.
//   · Acting on a task is reading it: a person's own write marks the task read, in
//     the same transaction as the write. So nothing can land between the two and be
//     swallowed, and their own move never comes back to them as news.
//
// The "since you last looked" line on the Board is a separate, per-browser view of
// what MOVED (useSeenBoard); this is the one record of what was READ.

import { isLocalPerson, wakeFromPerson } from '@clawboo/board-core'
import { and, asc, desc, eq, gt, inArray, isNull, max, or, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { parsePersonJson } from '../person'
import {
  taskActivity,
  taskComments,
  taskReaders,
  taskReads,
  tasks,
  type DbTaskWake,
} from '../schema'
import { wakeCommentIds } from '../taskWakes'
import { immediateWrite, withWriteRetry } from './contention'

/** The one built-in reader on an install with no sign-in. A local person would
 *  replace it (see readerOf in the server's boardReader.ts). */
export const LOCAL_READER = 'local'

/** Whose read state belongs to this person: a verified person's own, else the built-in
 *  reader's. A comment can name the built-in person (an answer or a Reopen does), and
 *  that person is the built-in reader. */
export function readerOfPerson(person: { id: string } | null): string {
  return person && !isLocalPerson(person.id) ? `person:${person.id}` : LOCAL_READER
}

export type TaskActivityKind = 'created' | 'status' | 'edited' | 'comment'

export interface TaskActivity {
  /** Position in the board's history; what a reader marks read through. */
  seq: number
  kind: TaskActivityKind
  at: number
}

export interface TaskReadState {
  unread: boolean
  activity: TaskActivity
}

/** The seq of the newest change anywhere on the board, 0 when there is none. */
export function boardActivityHead(db: ClawbooDb): number {
  return (
    db
      .select({ head: max(taskActivity.seq) })
      .from(taskActivity)
      .get()?.head ?? 0
  )
}

/** Goes up each time this reader marks anything read, 0 when they never have. Lets
 *  the event tail wake their other browsers. One row by key: it runs on every poll of
 *  every open stream. */
export function readerLastRead(db: ClawbooDb, readerId: string): number {
  return (
    db
      .select({ at: taskReaders.updatedAt })
      .from(taskReaders)
      .where(eq(taskReaders.readerId, readerId))
      .get()?.at ?? 0
  )
}

/** The position of the task's newest change, 0 when it has none on record. */
export function activitySeqOf(db: ClawbooDb, taskId: string): number {
  return (
    db
      .select({ seq: taskActivity.seq })
      .from(taskActivity)
      .where(eq(taskActivity.taskId, taskId))
      .get()?.seq ?? 0
  )
}

/**
 * Everything at or below this seq is read for this reader.
 *
 * The built-in reader needs no row until it marks all read: nothing is older than
 * the triggers, so it starts at 0 and whatever happened since they were installed
 * is news. A person new to a sign-in proxy starts caught up, so their first look is
 * not a long list of what happened before they arrived. A failed write only means
 * they start again from here on the next read.
 */
function readerBaseline(db: ClawbooDb, readerId: string): number {
  const stored = (): number | undefined =>
    db
      .select({ baselineSeq: taskReaders.baselineSeq })
      .from(taskReaders)
      .where(eq(taskReaders.readerId, readerId))
      .get()?.baselineSeq
  const known = stored()
  if (known !== undefined) return known
  if (readerId === LOCAL_READER) return 0
  const head = boardActivityHead(db)
  try {
    withWriteRetry(() =>
      db
        .insert(taskReaders)
        .values({ readerId, baselineSeq: head, updatedAt: Date.now() })
        .onConflictDoNothing()
        .run(),
    )
  } catch {
    // Reads must not fail on this; see above.
  }
  // Another process can get there first, with an older head. Its row is the one that
  // stays, and going by this read's newer head would hide what landed between the two.
  return stored() ?? head
}

function readSeqOf(db: ClawbooDb, readerId: string, taskId: string): number {
  return (
    db
      .select({ readSeq: taskReads.readSeq })
      .from(taskReads)
      .where(and(eq(taskReads.readerId, readerId), eq(taskReads.taskId, taskId)))
      .get()?.readSeq ?? 0
  )
}

/**
 * After a mark: move the reader's baseline up to just below their oldest unread
 * change, and record that they read.
 *
 * Without this, a reader who opens tasks one at a time never moves their baseline,
 * and the unread list walks every task they ever read on each read of the badge. The
 * walk here starts at the baseline and stops at the first unread change, so each read
 * row is passed once. It changes no answer: everything below that change is read.
 */
function noteReaderRead(db: ClawbooDb, readerId: string, baseline: number): void {
  const oldest = db
    .select({ seq: taskActivity.seq })
    .from(taskActivity)
    .innerJoin(tasks, eq(tasks.id, taskActivity.taskId))
    .leftJoin(
      taskReads,
      and(eq(taskReads.taskId, taskActivity.taskId), eq(taskReads.readerId, readerId)),
    )
    .where(
      and(
        gt(taskActivity.seq, baseline),
        eq(tasks.dropped, 0),
        or(isNull(taskReads.readSeq), gt(taskActivity.seq, taskReads.readSeq)),
      ),
    )
    .orderBy(asc(taskActivity.seq))
    .limit(1)
    .get()
  const next = oldest ? oldest.seq - 1 : boardActivityHead(db)
  const now = Date.now()
  db.insert(taskReaders)
    .values({ readerId, baselineSeq: Math.max(next, baseline), updatedAt: now })
    .onConflictDoUpdate({
      target: taskReaders.readerId,
      set: {
        baselineSeq: sql`max(${taskReaders.baselineSeq}, excluded.baseline_seq)`,
        // Strictly up, so a second mark in the same millisecond still wakes.
        updatedAt: sql`max(excluded.updated_at, ${taskReaders.updatedAt} + 1)`,
      },
    })
    .run()
}

function writeRead(db: ClawbooDb, readerId: string, taskId: string, seq: number): void {
  const now = Date.now()
  db.insert(taskReads)
    .values({ readerId, taskId, readSeq: seq, readAt: now })
    .onConflictDoUpdate({
      target: [taskReads.readerId, taskReads.taskId],
      // Never backwards: two tabs, or a late answer from a slow one.
      set: { readSeq: sql`max(${taskReads.readSeq}, excluded.read_seq)`, readAt: now },
    })
    .run()
}

/** This reader's state for every task with a recorded change, or just `taskId`'s. A
 *  task with none (last changed before the triggers) is absent, and is not unread. */
export function taskReadStates(
  db: ClawbooDb,
  readerId: string,
  opts: { taskId?: string } = {},
): Map<string, TaskReadState> {
  const baseline = readerBaseline(db, readerId)
  const rows = db
    .select({
      taskId: taskActivity.taskId,
      seq: taskActivity.seq,
      kind: taskActivity.kind,
      at: taskActivity.at,
      readSeq: taskReads.readSeq,
    })
    .from(taskActivity)
    .leftJoin(
      taskReads,
      and(eq(taskReads.taskId, taskActivity.taskId), eq(taskReads.readerId, readerId)),
    )
    .where(opts.taskId ? eq(taskActivity.taskId, opts.taskId) : undefined)
    .all()
  const out = new Map<string, TaskReadState>()
  for (const r of rows) {
    out.set(r.taskId, {
      unread: r.seq > Math.max(baseline, r.readSeq ?? 0),
      activity: { seq: r.seq, kind: r.kind as TaskActivityKind, at: r.at },
    })
  }
  return out
}

/** The tasks unread for this reader, newest change first, up to `limit`. */
export function unreadTasks(
  db: ClawbooDb,
  readerId: string,
  opts: { teamId?: string; limit?: number } = {},
): Array<{ id: string; seq: number }> {
  const baseline = readerBaseline(db, readerId)
  const query = db
    .select({ id: taskActivity.taskId, seq: taskActivity.seq })
    .from(taskActivity)
    .innerJoin(tasks, eq(tasks.id, taskActivity.taskId))
    .leftJoin(
      taskReads,
      and(eq(taskReads.taskId, taskActivity.taskId), eq(taskReads.readerId, readerId)),
    )
    .where(
      and(
        gt(taskActivity.seq, baseline),
        eq(tasks.dropped, 0),
        or(isNull(taskReads.readSeq), gt(taskActivity.seq, taskReads.readSeq)),
        opts.teamId ? eq(tasks.teamId, opts.teamId) : undefined,
      ),
    )
    .orderBy(desc(taskActivity.seq))
  return (opts.limit === undefined ? query : query.limit(opts.limit)).all()
}

/**
 * The reader has seen this task as of `through`. Clamped to the task's newest
 * change, so a number from nowhere cannot hide the changes still to come, and never
 * moves a reader back. Returns whether the task is still unread.
 */
export function markTaskRead(
  db: ClawbooDb,
  readerId: string,
  taskId: string,
  through: number,
): { unread: boolean } {
  return immediateWrite(db, () => {
    const baseline = readerBaseline(db, readerId)
    const seq = activitySeqOf(db, taskId)
    const mark = Math.min(through, seq)
    if (mark > 0) {
      writeRead(db, readerId, taskId, mark)
      noteReaderRead(db, readerId, baseline)
    }
    return { unread: seq > Math.max(baseline, readSeqOf(db, readerId, taskId)) }
  })
}

/**
 * The reader has seen everything as of `through`, on one team or the whole board.
 * Clamped like `markTaskRead`. The whole board only moves the baseline, so it costs
 * one row however many tasks there are.
 */
export function markAllTasksRead(
  db: ClawbooDb,
  readerId: string,
  through: number,
  opts: { teamId?: string } = {},
): void {
  immediateWrite(db, () => {
    const baseline = readerBaseline(db, readerId)
    const mark = Math.min(through, boardActivityHead(db))
    if (opts.teamId) {
      const rows = db
        .select({ taskId: taskActivity.taskId, seq: taskActivity.seq })
        .from(taskActivity)
        .innerJoin(tasks, eq(tasks.id, taskActivity.taskId))
        .where(and(eq(tasks.teamId, opts.teamId), sql`${taskActivity.seq} <= ${mark}`))
        .all()
      for (const r of rows) writeRead(db, readerId, r.taskId, r.seq)
      noteReaderRead(db, readerId, baseline)
      return
    }
    noteReaderRead(db, readerId, Math.max(baseline, mark))
  })
}

/** Whose read state a person's wakes belong to: whoever wrote the comments they carry.
 *  One with no comment, such as a Reopen with no note, names no one, and the built-in
 *  reader stands in. A wake no person is behind belongs to nobody. */
export function readersBehindWakes(db: ClawbooDb, wakes: readonly DbTaskWake[]): string[] {
  const fromPeople = wakes.filter((w) => wakeFromPerson(w.reason))
  if (fromPeople.length === 0) return []
  const ids = fromPeople.flatMap((w) => wakeCommentIds(w))
  const written =
    ids.length === 0
      ? []
      : db
          .select({ person: taskComments.person })
          .from(taskComments)
          .where(and(inArray(taskComments.id, ids), eq(taskComments.authorType, 'user')))
          .all()
  if (written.length === 0) return [LOCAL_READER]
  return [...new Set(written.map((c) => readerOfPerson(parsePersonJson(c.person))))]
}

/**
 * A change just made for these readers some time after they asked for it: the pump moving
 * a card for a person's comment once a hold lifts, or the claim of the run that comment
 * starts. It is their doing, so it does not come back to them as news. But they are not
 * looking at the task now, so unlike `runOwnWrite` it reads nothing for them: a reader
 * with something unread before the change (`before`, an `activitySeqOf`) still has it.
 * Call it in the change's own transaction, for the reason `runOwnWrite` gives.
 */
export function readLaterOwnChange(
  db: ClawbooDb,
  readerIds: readonly string[],
  taskId: string,
  before: number,
): void {
  const after = activitySeqOf(db, taskId)
  if (after <= before) return
  for (const readerId of readerIds) {
    const baseline = readerBaseline(db, readerId)
    if (before > Math.max(baseline, readSeqOf(db, readerId, taskId))) continue
    writeRead(db, readerId, taskId, after)
    noteReaderRead(db, readerId, baseline)
  }
}

/** Run a write made for these readers some time after they asked: see `readLaterOwnChange`. */
export function runLaterOwnWrite<T>(
  db: ClawbooDb,
  readerIds: readonly string[],
  taskId: string,
  write: () => T,
): T {
  return immediateWrite(db, () => {
    const before = activitySeqOf(db, taskId)
    const result = write()
    readLaterOwnChange(db, readerIds, taskId, before)
    return result
  })
}

/**
 * Run a person's own write. Acting on a task is reading it, so the write marks the
 * task read.
 *
 * It has to, whatever was unread before. Each task keeps one row of activity, so the
 * person's move replaces the news it answered: left unread, a Needs you card they
 * dismissed without opening would stay on the badge as "Moved to Cancelled". The price
 * is that an agent's comment they had not opened counts as read once they drag the
 * card. A write that changed nothing, such as a move the board refused, reads nothing.
 *
 * `readerId` null means the caller is not a person, so the write counts as someone
 * else's. `task` is the task's id, or how to read it from what the write returns,
 * for a task the write creates. That reads null when the write made nothing new, such
 * as a retried create that found its task already there: what has happened on the task
 * since is someone else's, and stays news.
 *
 * The write and the mark share one transaction. Taken apart, a comment from the
 * stdio bin could land between them and be swallowed. The write's own repository
 * calls open their transactions inside this one, which SQLite treats as savepoints,
 * and they cannot hit a lock while this one holds it.
 */
export function runOwnWrite<T>(
  db: ClawbooDb,
  readerId: string | null,
  task: string | ((result: T) => string | null),
  write: () => T,
): T {
  if (readerId === null) return write()
  return immediateWrite(db, () => {
    const baseline = readerBaseline(db, readerId)
    const before = typeof task === 'string' ? activitySeqOf(db, task) : 0
    const result = write()
    const taskId = typeof task === 'string' ? task : task(result)
    if (taskId === null) return result
    const after = activitySeqOf(db, taskId)
    if (after > before) {
      writeRead(db, readerId, taskId, after)
      noteReaderRead(db, readerId, baseline)
    }
    return result
  })
}
