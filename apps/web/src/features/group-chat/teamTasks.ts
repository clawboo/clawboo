// How the team chat's Tasks card sorts a team's board tasks into sections.
// Pure (no React, no stores) so the grouping is tested on its own.
//
// "Needs you" goes by the same verdict the Board's Needs you column uses
// (`taskAttentionOf`): a failed, stopped, parked, unassigned or blocked task
// waits on a person whatever its status says. Everything else goes by status.

import { taskAttentionOf, type TaskAttention } from '@/features/board/boardStatus'

export type TaskSectionId = 'needs_you' | 'in_progress' | 'todo' | 'done' | 'cancelled'

export interface TaskSection {
  id: TaskSectionId
  label: string
  /** Shown expanded until the person folds it. */
  defaultOpen: boolean
}

export const TASK_SECTIONS: readonly TaskSection[] = [
  { id: 'needs_you', label: 'Needs you', defaultOpen: true },
  { id: 'in_progress', label: 'In progress', defaultOpen: true },
  { id: 'todo', label: 'To do', defaultOpen: true },
  { id: 'done', label: 'Done', defaultOpen: false },
  { id: 'cancelled', label: 'Cancelled', defaultOpen: false },
]

export interface GroupableTask {
  status: string
  attention?: TaskAttention | null
  updatedAt: number
}

export function taskSectionOf(task: GroupableTask): TaskSectionId {
  if (taskAttentionOf(task)) return 'needs_you'
  switch (task.status) {
    case 'in_progress':
    case 'in_review':
      return 'in_progress'
    case 'done':
      return 'done'
    case 'cancelled':
      return 'cancelled'
    default:
      // todo, backlog, and any status the board does not know yet: waiting work.
      return 'todo'
  }
}

/** Every section, each newest first. Empty sections are kept (with no rows) so
 *  the card can show their counts. */
export function groupTeamTasks<T extends GroupableTask>(
  tasks: Iterable<T>,
): Record<TaskSectionId, T[]> {
  const out: Record<TaskSectionId, T[]> = {
    needs_you: [],
    in_progress: [],
    todo: [],
    done: [],
    cancelled: [],
  }
  for (const t of tasks) out[taskSectionOf(t)].push(t)
  for (const rows of Object.values(out)) rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

/**
 * Whether a task belongs to the chat room being viewed. The team's own group
 * chat (`roomId` null) holds the tasks with no room, which is every task created
 * before rooms existed; a room holds its own. A task whose room is unknown to the
 * client (`roomId` undefined: a frame that did not say) counts as the default
 * room's, which is where it was before rooms.
 */
export function inRoom(task: { roomId?: string | null }, roomId: string | null): boolean {
  return (task.roomId ?? null) === roomId
}

/** The tasks of one chat room (see `inRoom`). */
export function tasksInRoom<T extends { roomId?: string | null }>(
  tasks: Iterable<T>,
  roomId: string | null,
): T[] {
  const out: T[] = []
  for (const t of tasks) if (inRoom(t, roomId)) out.push(t)
  return out
}

/** "Oct 14" for an older date, "3h ago" style for today. */
export function shortWhen(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
