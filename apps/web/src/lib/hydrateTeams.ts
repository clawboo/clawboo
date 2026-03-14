import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'

/**
 * Hydrate teams from SQLite on connect + patch agent teamIds in fleet store.
 * Called after fleet hydration in GatewayBootstrap, CreateTeamModal, and TeamSidebar.
 */
export async function hydrateTeams(): Promise<void> {
  try {
    const r = await fetch('/api/teams?includeArchived=true')
    const data = (await r.json()) as {
      teams?: {
        id: string
        name: string
        icon: string
        color: string
        templateId: string | null
        isArchived: number
        agentCount: number
      }[]
      assignments?: { agentId: string; teamId: string }[]
    }
    if (data.teams?.length) {
      useTeamStore.getState().hydrateTeams(
        data.teams.map((t) => ({
          ...t,
          isArchived: !!t.isArchived,
        })),
      )
      if (!useTeamStore.getState().selectedTeamId) {
        const firstActive = data.teams.find((t) => !t.isArchived)
        if (firstActive) {
          useTeamStore.getState().selectTeam(firstActive.id)
        }
      }
    }

    // Patch fleet store with team assignments from SQLite
    if (data.assignments?.length) {
      const assignmentMap = new Map(data.assignments.map((a) => [a.agentId, a.teamId]))
      useFleetStore.setState((s) => ({
        agents: s.agents.map((a) => ({
          ...a,
          teamId: assignmentMap.get(a.id) ?? a.teamId,
        })),
      }))
    }
  } catch {
    // hydration failure is non-fatal
  }
}
