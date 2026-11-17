// A team's done and dropped goals, for the folded list on its Home: `GET /api/home`
// lists active goals only, so a goal marked done or dropped would otherwise be out
// of reach once the person leaves its page. Read when the team changes, after a
// write (`reloadKey`), and when a new Home snapshot changes the team's active goals
// (`activeGoalIds`: someone marked one done elsewhere); a failed read leaves the list
// empty.

import { useEffect, useState } from 'react'

import { listGoals, type GoalSummary } from '@clawboo/control-client'

const NONE: GoalSummary[] = []

export function useClosedGoals(
  teamId: string | null,
  reloadKey: number,
  /** The team's active goal ids from Home's snapshot, joined; null until it is read. */
  activeGoalIds: string | null,
): GoalSummary[] {
  // Tagged with the team it was read for: right after a switch the last team's list is
  // still held, and its goals must never open on the new team.
  const [read, setRead] = useState<{ teamId: string; goals: GoalSummary[] } | null>(null)
  useEffect(() => {
    if (!teamId || activeGoalIds === null) return
    let live = true
    listGoals(teamId)
      .then((all) => {
        if (!live) return
        setRead({
          teamId,
          goals: all.filter((g) => g.goal.status !== 'active' && g.goal.archivedAt === null),
        })
      })
      .catch(() => {
        if (live) setRead({ teamId, goals: [] })
      })
    return () => {
      live = false
    }
  }, [teamId, reloadKey, activeGoalIds])
  return read && read.teamId === teamId ? read.goals : NONE
}
