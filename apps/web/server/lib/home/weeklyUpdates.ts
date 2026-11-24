// "Turn on weekly updates" on a team's Home: a normal team routine, made through
// the same routine source as Routines, that asks the team's lead once a week to
// draft an update for each active goal with the Tasks tool `draft_goal_update`.
// Drafts wait on Home for a person, and count in Needs you. The routine runs in
// the routines' time zone and is paused, edited or deleted from Routines like
// any other.

import {
  getScheduledRun,
  getTeamHomeSettings,
  setTeamHomeSettings,
  type ClawbooDb,
  type TeamHomeSettingsRecord,
} from '@clawboo/db'

import { getScheduleMultiplexer } from '../scheduleSource/registry'

/** Mondays at 09:00, in the routines' time zone. */
export const WEEKLY_UPDATES_CRON = '0 9 * * 1'
export const WEEKLY_UPDATES_TITLE = 'Weekly goal updates'

/** What the lead is told each week. */
export const WEEKLY_UPDATES_INSTRUCTIONS = [
  "Draft this week's goal updates.",
  "Call list_goals to see the team's active goals. For each one, call get_goal, read its",
  'linked work, KPIs and last update, then call draft_goal_update with a short update:',
  'what got done, what is in the way, and what comes next. Name a health only when the',
  'work shows it. A person reviews and publishes each draft, so do not post the update',
  'anywhere else.',
].join(' ')

const ROUTINE_PREFIX = 'clawboo-routine:'

function routineExists(db: ClawbooDb, id: string): boolean {
  const raw = id.startsWith(ROUTINE_PREFIX) ? id.slice(ROUTINE_PREFIX.length) : id
  return getScheduledRun(db, raw) !== null
}

export interface WeeklyUpdatesResult {
  routineId: string
  created: boolean
  settings: TeamHomeSettingsRecord
}

/**
 * Make the team's weekly-update routine, or return the one already made. Throws
 * the routine source's own errors (an unknown or archived team), which the route
 * maps as Routines does.
 */
export async function turnOnWeeklyUpdates(
  db: ClawbooDb,
  teamId: string,
): Promise<WeeklyUpdatesResult> {
  const current = getTeamHomeSettings(db, teamId)
  if (current.weeklyUpdatesRoutineId && routineExists(db, current.weeklyUpdatesRoutineId)) {
    return { routineId: current.weeklyUpdatesRoutineId, created: false, settings: current }
  }
  const schedule = await getScheduleMultiplexer().write({
    kind: 'create',
    spec: {
      source: 'clawboo-routine',
      domain: 'team-task',
      target: 'team',
      teamId,
      cronSpec: WEEKLY_UPDATES_CRON,
      label: WEEKLY_UPDATES_TITLE,
      taskTemplate: { title: WEEKLY_UPDATES_TITLE, description: WEEKLY_UPDATES_INSTRUCTIONS },
    },
  })
  if (!schedule) throw new Error('the routine source made no routine')
  const settings = setTeamHomeSettings(db, teamId, { weeklyUpdatesRoutineId: schedule.id })
  return { routineId: schedule.id, created: true, settings }
}
