import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import type { CollectionId } from '@/lib/teamPalettes'
import { normalizeTeamColor } from '@/lib/normalizeTeamColor'

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
        colorCollectionId: CollectionId | null
        templateId: string | null
        leaderAgentId: string | null
        isArchived: number
        agentCount: number
      }[]
      assignments?: { agentId: string; teamId: string }[]
    }
    if (data.teams?.length) {
      useTeamStore.getState().hydrateTeams(
        data.teams.map((t) => ({
          ...t,
          color: normalizeTeamColor(t.color),
          isArchived: !!t.isArchived,
        })),
      )
      if (!useTeamStore.getState().selectedTeamId) {
        const firstActive = data.teams.find((t) => !t.isArchived)
        if (firstActive) {
          useTeamStore.getState().selectTeam(firstActive.id)
        }
      }

      // One-time cleanup: persist any legacy CSS-var (or otherwise non-hex)
      // team color back to the DB as hex, retiring the old values for good.
      // Idempotent — once a row is hex, `normalizeTeamColor` is a no-op so no
      // PATCH fires. Best-effort; the store already holds the normalized hex.
      for (const t of data.teams) {
        const normalized = normalizeTeamColor(t.color)
        if (normalized !== t.color) {
          void fetch(`/api/teams/${t.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ color: normalized }),
          }).catch(() => {
            /* non-fatal — the in-memory store is already normalized */
          })
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
