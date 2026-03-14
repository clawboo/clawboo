import { create } from 'zustand'

// ─── Team ────────────────────────────────────────────────────────────────────

export interface Team {
  id: string
  name: string
  icon: string
  color: string
  templateId: string | null
  agentCount: number
  isArchived: boolean
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
