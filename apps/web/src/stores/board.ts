// Board projection store — a READ-ONLY projection of the durable board (the
// canonical source of truth), NOT the source itself. The flag-on group chat
// renders task cards from here so they survive a refresh (re-`load`ed from
// SQLite-backed REST). Two writers: `load` (authoritative snapshot on team open)
// and `applyChange` (the orchestrator's client-derived change-feed). Merges are
// last-write-wins by `updatedAt` so optimistic-vs-reload ordering never races.
//
// IMPORTANT: this store is consumed in RENDER only (selectors / useMemo). Never
// put its Map in a `useEffect` dep list — the Map reference changes on every
// update and would re-fire effects (the rehydrate-cascade class of bug).

import { create } from 'zustand'

import { isTerminalStatus, taskAttentionOf, type TaskAttention } from '@/features/board/boardStatus'
import type { BoardChange } from '@/features/group-chat/boardOrchestration'
import { boardClient } from '@/lib/boardClient'

export interface BoardTaskView {
  id: string
  /** The readable id, like `CLB-12`; null or absent when it has none or none is known. */
  identifier?: string | null
  title: string
  status: string
  assigneeAgentId: string | null
  parentTaskId: string | null
  /** Report-up summary (from the change-feed `done`); null until completed. */
  summary: string | null
  /** Why the task needs a person, as the server last computed it. `undefined`
   *  means not known for the current status (a status frame that carried no
   *  verdict); readers fall back to the status via `taskAttentionOf`. */
  attention?: TaskAttention | null
  /** The chat room the task belongs to; null (or absent) = the team's own group chat. */
  roomId?: string | null
  /** What it waits on (the JSON reason), as the server last said for this status. */
  waitingOn?: string | null
  /** For a wait on other work, what its card names. */
  waitingOnDetail?: { taskTitle?: string; openSubtasks?: number } | null
  /** The person it is assigned to. Never with `assigneeAgentId`. */
  assigneePersonId?: string | null
  assigneePerson?: string | null
  /** When its check began waiting for teammates to leave the team folder. */
  checkHeldSince?: number | null
  createdAt: number
  updatedAt: number
}

/** A board change as the chat stream carries it: the engine's fields plus what the
 *  server reads off the row: the task's room and, on a move, what it waits on and the
 *  person it is assigned to. */
export type BoardChangeFrame = BoardChange & {
  roomId?: string | null
  waitingOn?: string | null
  waitingOnDetail?: { taskTitle?: string; openSubtasks?: number } | null
  assigneePersonId?: string | null
  assigneePerson?: string | null
}

function mergeTask(existing: BoardTaskView | undefined, change: BoardChangeFrame): BoardTaskView {
  const incomingUpdatedAt = change.updatedAt ?? existing?.updatedAt ?? Date.now()
  // A strictly-OLDER change must not regress a field: a reconnect `load()` snapshot can
  // predate a live board frame received during the connect gap, and copying its stale
  // status/assignee would roll the card BACKWARD while the timestamp clamp keeps the
  // newer time. Keep the newer existing state wholesale (the `load` change carries no
  // summary, so nothing additive is lost).
  if (existing && incomingUpdatedAt < existing.updatedAt) return existing
  const updatedAt = Math.max(incomingUpdatedAt, existing?.updatedAt ?? 0)
  const status = change.status ?? existing?.status ?? 'todo'
  const moved = status !== existing?.status
  // A task that left Done or Cancelled was reopened, and the report of the run that
  // finished it is not about what it is doing now.
  const reopened = isTerminalStatus(existing?.status ?? '') && !isTerminalStatus(status)
  const assigneePersonId =
    change.assigneePersonId !== undefined
      ? change.assigneePersonId
      : (existing?.assigneePersonId ?? null)
  return {
    id: change.id,
    identifier: change.identifier ?? existing?.identifier ?? null,
    title: change.title ?? existing?.title ?? '',
    status,
    // One assignee: a person having it means no agent does, whatever the last frame
    // that named an agent said.
    assigneeAgentId: assigneePersonId
      ? null
      : (change.assigneeAgentId ?? existing?.assigneeAgentId ?? null),
    assigneePersonId,
    assigneePerson:
      change.assigneePerson !== undefined
        ? change.assigneePerson
        : (existing?.assigneePerson ?? null),
    parentTaskId: change.parentTaskId ?? existing?.parentTaskId ?? null,
    // summary is additive — a later non-summary change must not erase it.
    summary: change.summary ?? (reopened ? null : (existing?.summary ?? null)),
    // Like the verdict below: what the frame said, else the old one holds only while
    // the status is unchanged.
    waitingOn:
      change.waitingOn !== undefined ? change.waitingOn : moved ? undefined : existing?.waitingOn,
    waitingOnDetail:
      change.waitingOnDetail !== undefined
        ? change.waitingOnDetail
        : moved
          ? undefined
          : existing?.waitingOnDetail,
    // A verdict that came WITH this change wins. Otherwise the old one holds only
    // while the status is unchanged: a card that moved has not been re-judged.
    attention:
      change.attention !== undefined
        ? change.attention
        : status === existing?.status
          ? existing.attention
          : undefined,
    // A task never changes room; a frame that did not say keeps the known one.
    roomId: change.roomId !== undefined ? change.roomId : (existing?.roomId ?? null),
    // Waiting only ever means In review, so a frame from any other status ends it.
    checkHeldSince:
      status !== 'in_review'
        ? null
        : change.checkHeldSince !== undefined
          ? change.checkHeldSince
          : (existing?.checkHeldSince ?? null),
    createdAt: change.createdAt ?? existing?.createdAt ?? Date.now(),
    updatedAt,
  }
}

interface BoardStoreState {
  tasksByTeam: Map<string, Map<string, BoardTaskView>>
  loadedTeams: Set<string>
  /** Authoritative snapshot from REST (merge, never clear — refresh-survival). */
  load: (teamId: string) => Promise<void>
  /** Apply one orchestrator mutation (LWW by updatedAt). */
  applyChange: (teamId: string, change: BoardChangeFrame) => void
  reset: (teamId: string) => void
}

export const useBoardStore = create<BoardStoreState>((set) => ({
  tasksByTeam: new Map(),
  loadedTeams: new Set(),

  load: async (teamId) => {
    const rows = await boardClient.listTasks(teamId)
    set((state) => {
      const byTeam = new Map(state.tasksByTeam)
      const tasks = new Map(byTeam.get(teamId) ?? [])
      for (const r of rows) {
        tasks.set(
          r.id,
          mergeTask(tasks.get(r.id), {
            id: r.id,
            identifier: r.identifier ?? null,
            title: r.title,
            status: r.status,
            assigneeAgentId: r.assigneeAgentId ?? null,
            parentTaskId: r.parentTaskId ?? null,
            attention: taskAttentionOf(r),
            roomId: typeof r.roomId === 'string' ? r.roomId : null,
            waitingOn: typeof r['waitingOn'] === 'string' ? r['waitingOn'] : null,
            waitingOnDetail:
              (r['waitingOnDetail'] as BoardTaskView['waitingOnDetail'] | undefined) ?? null,
            assigneePersonId:
              typeof r['assigneePersonId'] === 'string' ? r['assigneePersonId'] : null,
            assigneePerson: typeof r['assigneePerson'] === 'string' ? r['assigneePerson'] : null,
            checkHeldSince: typeof r['checkHeldSince'] === 'number' ? r['checkHeldSince'] : null,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }),
        )
      }
      byTeam.set(teamId, tasks)
      return { tasksByTeam: byTeam, loadedTeams: new Set(state.loadedTeams).add(teamId) }
    })
  },

  applyChange: (teamId, change) => {
    set((state) => {
      const byTeam = new Map(state.tasksByTeam)
      const tasks = new Map(byTeam.get(teamId) ?? [])
      tasks.set(change.id, mergeTask(tasks.get(change.id), change))
      byTeam.set(teamId, tasks)
      return { tasksByTeam: byTeam }
    })
  },

  reset: (teamId) => {
    set((state) => {
      const byTeam = new Map(state.tasksByTeam)
      byTeam.delete(teamId)
      const loaded = new Set(state.loadedTeams)
      loaded.delete(teamId)
      return { tasksByTeam: byTeam, loadedTeams: loaded }
    })
  },
}))
