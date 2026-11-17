// The team's goals in an agent's turn (the volatile tier of the team preamble).
// A lead sees the team's active goals, so what it hands out can serve them; a
// worker sees only its task's goal, which is all it needs and keeps its turn
// short. Capped: a team with many goals shows the first few by position.

import {
  buildGoalIndex,
  getTeamGoal,
  goalProgressOf,
  listTeamGoals,
  resolveTaskGoal,
  type ClawbooDb,
} from '@clawboo/db'

/** How many goals a lead's turn lists, and how long a title may run there. */
export const GOALS_IN_LEAD_TURN = 8
const TITLE_CHARS = 120

const clip = (s: string): string => (s.length > TITLE_CHARS ? `${s.slice(0, TITLE_CHARS - 1)}…` : s)

const HEALTH_WORDS = { on_track: 'on track', at_risk: 'at risk', off_track: 'off track' } as const

function dateWord(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The goals block for a turn, or null when there is nothing to say. */
export function buildGoalsBlock(
  db: ClawbooDb,
  teamId: string,
  opts: { isLeader: boolean; taskId?: string | null },
): string | null {
  if (opts.isLeader) {
    const goals = listTeamGoals(db, teamId).filter((g) => g.status === 'active')
    if (goals.length === 0) return null
    const shown = goals.slice(0, GOALS_IN_LEAD_TURN)
    const index = buildGoalIndex(db, shown, [teamId])
    const lines = shown.map((g) => {
      const p = goalProgressOf(index, g.id)
      const bits = [
        g.health ? HEALTH_WORDS[g.health] : null,
        g.targetDate ? `due ${dateWord(g.targetDate)}` : null,
        p.total > 0 ? `${p.done} of ${p.total} tasks done` : 'no linked tasks yet',
      ].filter(Boolean)
      return `- ${clip(g.title)} (${bits.join(', ')})`
    })
    const more = goals.length > shown.length ? `\n…and ${goals.length - shown.length} more.` : ''
    return [
      '[Team Goals, set by a person]',
      ...lines,
      `${more ? more.trim() + '\n' : ''}Work you hand out serves one of these when it can. Use list_goals and get_goal for more.`,
      '[End Team Goals]',
    ].join('\n')
  }
  if (!opts.taskId) return null
  const link = resolveTaskGoal(db, opts.taskId)
  const goal = link ? getTeamGoal(db, teamId, link.goalId) : null
  if (!goal) return null
  return `[Goal of this task] ${clip(goal.title)}`
}
