// The teams and agents a routine can point at, read once for the routine dialog.
// Shared by the Routines view and the Board's calendar, which opens the same
// dialog from a routine's run.

import { apiFetch, listAgents } from '@clawboo/control-client'

import type { RoutineDirectory } from './RoutineDialog'

export const EMPTY_DIRECTORY: RoutineDirectory = { teams: [], agents: [], booZeroName: null }

/** The teams and agents a routine can point at. Null when they could not be read. */
export async function loadRoutineDirectory(): Promise<RoutineDirectory | null> {
  try {
    const [teamsRes, agentList] = await Promise.all([apiFetch('/api/teams'), listAgents()])
    const teamsBody = teamsRes.ok
      ? ((await teamsRes.json()) as {
          teams?: Array<{ id: string; name: string; icon?: string; isArchived?: unknown }>
        })
      : {}
    const teams = (teamsBody.teams ?? [])
      .filter((t) => !t.isArchived)
      .map((t) => ({ id: t.id, name: t.name, icon: t.icon ?? '' }))
    const live = agentList.agents.filter(
      (a) => !a.archivedAt && (a.participantKind as string | undefined) !== 'human',
    )
    const agents = live.map((a) => ({
      id: a.id,
      name: a.displayName,
      // Keep an unknown runtime unknown rather than guessing one.
      runtime: (a.runtime as string | undefined) ?? '',
      teamId: a.teamId ?? null,
    }))
    const booZero = agentList.defaultId ? live.find((a) => a.id === agentList.defaultId) : undefined
    return { teams, agents, booZeroName: booZero?.displayName ?? null }
  } catch {
    return null
  }
}
