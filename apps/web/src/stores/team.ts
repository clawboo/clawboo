import { create } from 'zustand'

import type { CollectionId } from '@/lib/teamPalettes'

// ─── Team ────────────────────────────────────────────────────────────────────

export interface Team {
  id: string
  name: string
  icon: string
  color: string
  /** Chosen generative color collection; null on legacy teams → default applies. */
  colorCollectionId: CollectionId | null
  templateId: string | null
  agentCount: number
  leaderAgentId: string | null
  isArchived: boolean
  /**
   * True when the SERVER orchestrator owns this team's chat (native, Gateway-free
   * teams). `GroupChatPanel` renders these via the REST-send + SSE-stream thin-client
   * path (composer works with `client === null`); the browser board-orchestration
   * path is gated OFF for them. OpenClaw teams are false → legacy browser path.
   */
  serverOrchestrated: boolean
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface TeamStore {
  teams: Team[]
  selectedTeamId: string | null

  /** Replace the full team list (called on initial load). */
  hydrateTeams: (teams: Team[]) => void

  /** Select a team by id (pass null to deselect). */
  selectTeam: (id: string | null) => void

  /** Add a single team (after creation). */
  addTeam: (team: Team) => void

  /** Remove a team by id. */
  removeTeam: (id: string) => void

  /** Set or clear the leader agent for a team. */
  setTeamLeader: (teamId: string, agentId: string | null) => void

  /** Patch a team's fields. */
  updateTeam: (id: string, patch: Partial<Team>) => void

  /** Archive a team — sets isArchived and deselects if selected. */
  archiveTeam: (id: string) => void

  /** Unarchive a team. */
  unarchiveTeam: (id: string) => void
}

export const useTeamStore = create<TeamStore>((set) => ({
  teams: [],
  selectedTeamId: null,

  hydrateTeams: (teams) => set({ teams }),

  selectTeam: (id) => set({ selectedTeamId: id }),

  addTeam: (team) =>
    set((state) => ({
      teams: [...state.teams, team],
    })),

  setTeamLeader: (teamId, agentId) =>
    set((state) => ({
      teams: state.teams.map((t) => (t.id === teamId ? { ...t, leaderAgentId: agentId } : t)),
    })),

  removeTeam: (id) =>
    set((state) => ({
      teams: state.teams.filter((t) => t.id !== id),
      selectedTeamId: state.selectedTeamId === id ? null : state.selectedTeamId,
    })),

  updateTeam: (id, patch) =>
    set((state) => ({
      teams: state.teams.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  archiveTeam: (id) =>
    set((state) => ({
      teams: state.teams.map((t) => (t.id === id ? { ...t, isArchived: true } : t)),
      selectedTeamId: state.selectedTeamId === id ? null : state.selectedTeamId,
    })),

  unarchiveTeam: (id) =>
    set((state) => ({
      teams: state.teams.map((t) => (t.id === id ? { ...t, isArchived: false } : t)),
    })),
}))
