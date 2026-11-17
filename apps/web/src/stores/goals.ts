// Each team's goals, as the Board needs them: a chip's title on a card, the goal
// picker in the drawer, the New task dialog and team chat, and the goal filter.
//
// Read on demand, per team, and kept until Home changes a goal (Home calls
// `invalidate`). A read that fails (an engine without Home, say) keeps an empty
// list, so the Board shows no goal parts rather than an error.

import { create } from 'zustand'
import { listGoals, type GoalHealth, type GoalLinkVia } from '@clawboo/control-client'

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
/** Each team's newest read. A forced read always starts a new one (a goal changed
 *  after the read in flight began), and only the newest read's answer is kept. */
const generation = new Map<string, number>()

export const useGoalsStore = create<GoalsStore>((set, get) => ({
  byTeam: {},
  load: (teamId, force = false) => {
    const known = get().byTeam[teamId]
    if (known && !force) return Promise.resolve(known)
    const running = inflight.get(teamId)
    if (running && !force) return running
    const mine = (generation.get(teamId) ?? 0) + 1
    generation.set(teamId, mine)
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
        // A newer read started meanwhile: its answer is the one to keep.
        if (generation.get(teamId) !== mine) return get().byTeam[teamId] ?? list
        set((s) => ({ byTeam: { ...s.byTeam, [teamId]: list } }))
        return list
      })
      .finally(() => {
        if (inflight.get(teamId) === read) inflight.delete(teamId)
      })
    inflight.set(teamId, read)
    return read
  },
  invalidate: (teamId) => {
    // Unknown and not being read: nothing to refresh. A first read in flight began
    // before the change, so it is read again.
    if (get().byTeam[teamId] === undefined && !inflight.has(teamId)) return
    void get().load(teamId, true)
  },
}))

/** Test helper: forget every team's goals. */
export function resetGoalsStore(): void {
  inflight.clear()
  generation.clear()
  useGoalsStore.setState({ byTeam: {} })
}

/** The goal a task itself names, read off a board row (`goalId`). Null for none of
 *  its own, even when it counts toward its request's goal. */
export function goalIdOf(task: { [k: string]: unknown }): string | null {
  const id = task['goalId']
  return typeof id === 'string' && id ? id : null
}

/** The goal a task counts toward: its own, else its request's or a parent's
 *  (`effectiveGoalId`, which the goal page's progress also counts). A row from a
 *  server that does not send it falls back to the task's own goal. */
export function effectiveGoalIdOf(task: { [k: string]: unknown }): string | null {
  if (!('effectiveGoalId' in task)) return goalIdOf(task)
  const id = task['effectiveGoalId']
  return typeof id === 'string' && id ? id : null
}

/** The goal a chat card's task counts toward (`effectiveGoalId`), falling back to its
 *  own goal for a frame from a server that does not send it. */
export function viewGoalOf(task: {
  goalId?: string | null
  effectiveGoalId?: string | null
}): string | null {
  return task.effectiveGoalId !== undefined ? task.effectiveGoalId : (task.goalId ?? null)
}

/** How the task reaches the goal it counts toward, when the row says. */
export function goalLinkOf(task: { [k: string]: unknown }): GoalLinkVia | null {
  const via = task['goalLinkedVia']
  return via === 'own' || via === 'request' || via === 'parent' ? via : null
}
