// Team verify command: the check a person sets for a team's tasks, persisted in
// the settings key/value table (`team-verify-command:<teamId>`, JSON
// `{ command }`). The verification gate runs it in place of the command in a task
// worktree's init.sh, which the builder can edit, and records the verdict as
// `commandSource: 'configured'`. New task worktrees are scaffolded with it too,
// so the builder sees in init.sh the check it will be held to. Unset or empty:
// the gate falls back to the worktree's own command.

import { getSetting, type ClawbooDb } from '@clawboo/db'

export function teamVerifyCommandSettingKey(teamId: string): string {
  return `team-verify-command:${teamId}`
}

/** The team's verify command, or null when none is set. */
export function readTeamVerifyCommand(db: ClawbooDb, teamId: string | null): string | null {
  if (!teamId) return null
  const raw = getSetting(db, teamVerifyCommandSettingKey(teamId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { command?: unknown }
    return typeof parsed.command === 'string' && parsed.command.trim()
      ? parsed.command.trim()
      : null
  } catch {
    return null
  }
}
