// How the Inbox reads a board row. Pure. A row carries its read state from the
// server (`unread`, `activity`); a mark this page already sent wins over a row read
// before it landed, because seqs only grow.

import type { TaskActivity } from '@clawboo/db'

import type { BoardTask } from '@/lib/boardClient'
import { statusLabel } from '@/features/board/boardStatus'

/** The tabs, in order. Room for `mine` once every install has a person: it needs
 *  one to say whose tasks are whose. */
export type InboxTab = 'needs-you' | 'unread' | 'all'

export type { TaskActivity }

const KINDS: ReadonlySet<string> = new Set(['created', 'status', 'edited', 'comment'])

/** The task's newest change, or null when it has none on record. */
export function activityOf(task: BoardTask): TaskActivity | null {
  const a = task['activity'] as Partial<TaskActivity> | null | undefined
  if (!a || typeof a.seq !== 'number' || typeof a.at !== 'number') return null
  if (typeof a.kind !== 'string' || !KINDS.has(a.kind)) return null
  return { seq: a.seq, at: a.at, kind: a.kind }
}

export interface ReadMarks {
  marks: Readonly<Record<string, number>>
  allMark: number
}

export function isUnread(task: BoardTask, { marks, allMark }: ReadMarks): boolean {
  if (task['unread'] !== true) return false
  const seq = activityOf(task)?.seq ?? 0
  return seq > Math.max(marks[task.id] ?? 0, allMark)
}

/** Newest change first. A task with none on record goes after those that have one. */
export function byNewestChange(a: BoardTask, b: BoardTask): number {
  const seqA = activityOf(a)?.seq ?? 0
  const seqB = activityOf(b)?.seq ?? 0
  if (seqA !== seqB) return seqB - seqA
  return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
}

/** What changed, in words. */
export function changeLabel(task: BoardTask): string {
  switch (activityOf(task)?.kind) {
    case 'comment':
      return 'New comment'
    case 'created':
      return 'New task'
    case 'edited':
      return 'Edited'
    case 'status':
      return `Moved to ${statusLabel(task.status)}`
    default:
      return statusLabel(task.status)
  }
}

/** When it changed. A task with no change on record falls back to its last write. */
export function changedAt(task: BoardTask): number | null {
  const at = activityOf(task)?.at ?? task.updatedAt
  return typeof at === 'number' ? at : null
}

/** The newest change among these rows: what "mark all read" covers. */
export function newestSeq(tasks: readonly BoardTask[]): number {
  return tasks.reduce((n, t) => Math.max(n, activityOf(t)?.seq ?? 0), 0)
}
