// A team's "always allow": may its agents wake each other without a person being asked
// once per job? Source of truth: the settings row `team-agent-wakes:<teamId>`, behind
// GET/PUT /api/team-agent-wakes/:teamId. Edited from `TeamSettingsSheet`, beside the
// work check, and set from the card's "Always allow in this team".

import { apiFetch } from '@clawboo/control-client'

import { isPersonOnlyRefusal } from './personCheckNotice'

/** The setting, or null when it could not be read. */
export async function fetchTeamAgentWakes(teamId: string): Promise<boolean | null> {
  try {
    const res = await apiFetch(`/api/team-agent-wakes/${encodeURIComponent(teamId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as { always?: unknown }
    return typeof body.always === 'boolean' ? body.always : null
  } catch {
    return null
  }
}

/** Save it. Returns what is stored now, `person_only` when the server's person check
 *  refused it, which trying again would not change, or null when the save failed. */
export async function saveTeamAgentWakes(
  teamId: string,
  always: boolean,
): Promise<boolean | 'person_only' | null> {
  try {
    const res = await apiFetch(`/api/team-agent-wakes/${encodeURIComponent(teamId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ always }),
    })
    if (!res.ok) return (await isPersonOnlyRefusal(res)) ? 'person_only' : null
    const body = (await res.json()) as { always?: unknown }
    return typeof body.always === 'boolean' ? body.always : null
  } catch {
    return null
  }
}
