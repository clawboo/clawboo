// A team's done and dropped goals, for the folded list on its Home: `GET /api/home`
// lists active goals only, so a goal marked done or dropped would otherwise be out
// of reach once the person leaves its page. Read when the team changes and after a
// write (`reloadKey`); a failed read leaves the list empty.

import { useEffect, useState } from 'react'

import { listGoals, type GoalSummary } from '@clawboo/control-client'

export function useClosedGoals(teamId: string | null, reloadKey: number): GoalSummary[] {
  const [goals, setGoals] = useState<GoalSummary[]>([])
  useEffect(() => {
    if (!teamId) {
      setGoals([])
      return
    }
    let live = true
    listGoals(teamId)
      .then((all) => {
        if (!live) return
        setGoals(all.filter((g) => g.goal.status !== 'active' && g.goal.archivedAt === null))
      })
      .catch(() => {
        if (live) setGoals([])
      })
    return () => {
      live = false
    }
  }, [teamId, reloadKey])
  return goals
}
