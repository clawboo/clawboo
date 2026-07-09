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

import type { BoardChange } from '@/features/group-chat/boardOrchestration'
import { boardClient } from '@/lib/boardClient'

export interface BoardTaskView {
  id: string
  title: string
  status: string
  assigneeAgentId: string | null
  parentTaskId: string | null
  /** Report-up summary (from the change-feed `done`); null until completed. */
  summary: string | null
  createdAt: number
  updatedAt: number
}

function mergeTask(existing: BoardTaskView | undefined, change: BoardChange): BoardTaskView {
  const incomingUpdatedAt = change.updatedAt ?? existing?.updatedAt ?? Date.now()
  // A strictly-OLDER change must not regress a field: a reconnect `load()` snapshot can
  // predate a live board frame received during the connect gap, and copying its stale
  // status/assignee would roll the card BACKWARD while the timestamp clamp keeps the
  // newer time. Keep the newer existing state wholesale (the `load` change carries no
  // summary, so nothing additive is lost).
  if (existing && incomingUpdatedAt < existing.updatedAt) return existing
  const updatedAt = Math.max(incomingUpdatedAt, existing?.updatedAt ?? 0)
  return {
    id: change.id,
    title: change.title ?? existing?.title ?? '',
    status: change.status ?? existing?.status ?? 'todo',
    assigneeAgentId: change.assigneeAgentId ?? existing?.assigneeAgentId ?? null,
    parentTaskId: change.parentTaskId ?? existing?.parentTaskId ?? null,
    // summary is additive — a later non-summary change must not erase it.
    summary: change.summary ?? existing?.summary ?? null,
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
  applyChange: (teamId: string, change: BoardChange) => void
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
            title: r.title,
            status: r.status,
            assigneeAgentId: r.assigneeAgentId ?? null,
            parentTaskId: r.parentTaskId ?? null,
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
