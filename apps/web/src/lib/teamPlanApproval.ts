// The team's "ask me before splitting work" switch: whether a plan waits for a person
// before any of its steps start. Source of truth: the settings row
// `team-plan-approval:<teamId>`, behind GET/PUT /api/team-plan-approval/:teamId.
//
// Edited from the "Plans" section of `TeamSettingsSheet`.

import { apiFetch } from '@clawboo/control-client'

import { isPersonOnlyRefusal } from './personCheckNotice'

/** Whether the team asks first, or null when it could not be read. */
export async function fetchTeamPlanApproval(teamId: string): Promise<boolean | null> {
  try {
    const res = await apiFetch(`/api/team-plan-approval/${encodeURIComponent(teamId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as { on?: unknown }
    return typeof body.on === 'boolean' ? body.on : null
  } catch {
    return null
  }
}

/** Set the switch. Returns what is stored, `person_only` when the server's person check
 *  refused it, which trying again would not change, or null when the save failed. */
export async function saveTeamPlanApproval(
  teamId: string,
  on: boolean,
): Promise<boolean | 'person_only' | null> {
  try {
    const res = await apiFetch(`/api/team-plan-approval/${encodeURIComponent(teamId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    })
    if (!res.ok) return (await isPersonOnlyRefusal(res)) ? 'person_only' : null
    const body = (await res.json()) as { on?: unknown }
    return typeof body.on === 'boolean' ? body.on : null
  } catch {
    return null
  }
}
