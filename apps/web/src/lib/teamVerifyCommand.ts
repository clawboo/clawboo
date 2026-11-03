// Team verify command: the check the verification gate runs for a team's tasks
// in place of the command in a task worktree's init.sh. Unset, the gate uses the
// command the agent wrote there. Source of truth: the settings row
// `team-verify-command:<teamId>`, behind GET/PUT /api/team-verify-command/:teamId.
//
// Edited from the "Work check" section of `TeamSettingsSheet`.

import { apiFetch } from '@clawboo/control-client'

/** The server's cap. It also refuses line breaks: init.sh stores one line. */
export const TEAM_VERIFY_COMMAND_MAX_CHARS = 2000

// Saves still in flight, per team. The settings sheet can close while one is
// pending, and a read started before it lands would show the old command.
const pendingSaves = new Map<string, Promise<string | null>>()

/** The team's verify command ('' when none is set), or null when it could not be read. */
export async function fetchTeamVerifyCommand(teamId: string): Promise<string | null> {
  await pendingSaves.get(teamId)
  try {
    const res = await apiFetch(`/api/team-verify-command/${encodeURIComponent(teamId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as { command?: unknown }
    return typeof body.command === 'string' ? body.command : null
  } catch {
    return null
  }
}

/**
 * Set the team's verify command; an empty string clears it. Returns the stored
 * command (the server trims it), or null when the save failed.
 */
export function saveTeamVerifyCommand(teamId: string, command: string): Promise<string | null> {
  const save = putTeamVerifyCommand(teamId, command).finally(() => {
    if (pendingSaves.get(teamId) === save) pendingSaves.delete(teamId)
  })
  pendingSaves.set(teamId, save)
  return save
}

async function putTeamVerifyCommand(teamId: string, command: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/team-verify-command/${encodeURIComponent(teamId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { command?: unknown }
    return typeof body.command === 'string' ? body.command : null
  } catch {
    return null
  }
}
