// Each team's goals, as the Board needs them: a chip's title on a card, the goal
// picker in the drawer, the New task dialog and team chat, and the goal filter.
//
// Read on demand, per team, and kept until Home changes a goal (Home calls
// `invalidate`). A read that fails (an engine without Home, say) keeps an empty
// list, so the Board shows no goal parts rather than an error.

import { create } from 'zustand'
import { listGoals, type GoalHealth } from '@clawboo/control-client'

export interface GoalOption {
  id: string
  teamId: string
  title: string
  parentGoalId: string | null
  health: GoalHealth | null
}

interface GoalsStore {
  /** Each team's active goals, in Home's order. Missing: not read yet. */
  byTeam: Record<string, GoalOption[]>
  /** Read a team's goals unless they are known (or being read). `force` reads again. */
  load: (teamId: string, force?: boolean) => Promise<GoalOption[]>
  /** Forget a team's goals, and read them again if they were known. */
  invalidate: (teamId: string) => void
}

const inflight = new Map<string, Promise<GoalOption[]>>()

export const useGoalsStore = create<GoalsStore>((set, get) => ({
  byTeam: {},
  load: (teamId, force = false) => {
    const known = get().byTeam[teamId]
    if (known && !force) return Promise.resolve(known)
    const running = inflight.get(teamId)
    if (running) return running
    const read = listGoals(teamId)
      .then((goals) =>
        goals
          .filter((g) => g.goal.status === 'active' && g.goal.archivedAt === null)
          .map((g) => ({
            id: g.goal.id,
            teamId: g.goal.teamId,
            title: g.goal.title,
            parentGoalId: g.goal.parentGoalId,
            health: g.goal.health,
          })),
      )
      .catch(() => [] as GoalOption[])
      .then((list) => {
        set((s) => ({ byTeam: { ...s.byTeam, [teamId]: list } }))
        return list
      })
      .finally(() => inflight.delete(teamId))
    inflight.set(teamId, read)
    return read
  },
  invalidate: (teamId) => {
    if (get().byTeam[teamId] === undefined) return
    void get().load(teamId, true)
  },
}))

/** Test helper: forget every team's goals. */
export function resetGoalsStore(): void {
  inflight.clear()
  useGoalsStore.setState({ byTeam: {} })
}

/** A task's goal id, read off a board row (rows carry `goalId`). */
export function goalIdOf(task: { [k: string]: unknown }): string | null {
  const id = task['goalId']
  return typeof id === 'string' && id ? id : null
}
