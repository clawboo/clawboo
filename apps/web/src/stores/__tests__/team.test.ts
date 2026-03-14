import { describe, it, expect, beforeEach } from 'vitest'
import { useTeamStore } from '../team'
import type { Team } from '../team'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 't1',
    name: 'Test Team',
    icon: '🚀',
    color: '#E94560',
    templateId: null,
    agentCount: 0,
    isArchived: false,
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useTeamStore', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [], selectedTeamId: null })
  })

  it('starts with empty teams and null selectedTeamId', () => {
    const state = useTeamStore.getState()
    expect(state.teams).toEqual([])
    expect(state.selectedTeamId).toBeNull()
  })

  // ── hydrateTeams ─────────────────────────────────────────────────────────

  describe('hydrateTeams', () => {
    it('replaces the full team list', () => {
      const teams = [makeTeam({ id: 't1' }), makeTeam({ id: 't2', name: 'Second' })]
      useTeamStore.getState().hydrateTeams(teams)
      expect(useTeamStore.getState().teams).toEqual(teams)
    })

    it('preserves selectedTeamId (hydrateTeams does not touch it)', () => {
      useTeamStore.setState({ selectedTeamId: 't1' })
      useTeamStore.getState().hydrateTeams([makeTeam({ id: 't1' })])
      expect(useTeamStore.getState().selectedTeamId).toBe('t1')
    })

    it('does not reset selectedTeamId even if team is not in new list', () => {
      // hydrateTeams is just set({ teams }) — it never touches selectedTeamId
      useTeamStore.setState({ selectedTeamId: 'old-id' })
      useTeamStore.getState().hydrateTeams([makeTeam({ id: 't1' })])
      expect(useTeamStore.getState().selectedTeamId).toBe('old-id')
    })
  })

  // ── selectTeam ───────────────────────────────────────────────────────────

  describe('selectTeam', () => {
    it('sets selectedTeamId', () => {
      useTeamStore.getState().selectTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBe('t1')
    })

    it('deselects with null', () => {
      useTeamStore.setState({ selectedTeamId: 't1' })
      useTeamStore.getState().selectTeam(null)
      expect(useTeamStore.getState().selectedTeamId).toBeNull()
    })
  })

  // ── addTeam ──────────────────────────────────────────────────────────────

  describe('addTeam', () => {
    it('appends a team to the list', () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 't1' })] })
      useTeamStore.getState().addTeam(makeTeam({ id: 't2', name: 'New' }))
      const teams = useTeamStore.getState().teams
      expect(teams).toHaveLength(2)
      expect(teams[1]!.id).toBe('t2')
    })
  })

  // ── removeTeam ───────────────────────────────────────────────────────────

  describe('removeTeam', () => {
    it('removes a team by id', () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })] })
      useTeamStore.getState().removeTeam('t1')
      const teams = useTeamStore.getState().teams
      expect(teams).toHaveLength(1)
      expect(teams[0]!.id).toBe('t2')
    })

    it('deselects if the removed team was selected', () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })],
        selectedTeamId: 't1',
      })
      useTeamStore.getState().removeTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBeNull()
    })

    it('does not deselect if a different team was selected', () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })],
        selectedTeamId: 't2',
      })
      useTeamStore.getState().removeTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBe('t2')
    })
  })

  // ── updateTeam ───────────────────────────────────────────────────────────

  describe('updateTeam', () => {
    it('patches fields of an existing team', () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 't1', name: 'Old' })] })
      useTeamStore.getState().updateTeam('t1', { name: 'New', color: '#34D399' })
      const team = useTeamStore.getState().teams[0]!
      expect(team.name).toBe('New')
      expect(team.color).toBe('#34D399')
    })

    it('does not modify other teams', () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1', name: 'Alpha' }), makeTeam({ id: 't2', name: 'Beta' })],
      })
      useTeamStore.getState().updateTeam('t1', { name: 'Updated' })
      expect(useTeamStore.getState().teams[1]!.name).toBe('Beta')
    })
  })

  // ── archiveTeam ──────────────────────────────────────────────────────────

  describe('archiveTeam', () => {
    it('sets isArchived to true', () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 't1', isArchived: false })] })
      useTeamStore.getState().archiveTeam('t1')
      expect(useTeamStore.getState().teams[0]!.isArchived).toBe(true)
    })

    it('deselects if the archived team was selected', () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' })],
        selectedTeamId: 't1',
      })
      useTeamStore.getState().archiveTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBeNull()
    })

    it('does not deselect if a different team was selected', () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })],
        selectedTeamId: 't2',
      })
      useTeamStore.getState().archiveTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBe('t2')
    })
  })

  // ── unarchiveTeam ────────────────────────────────────────────────────────

  describe('unarchiveTeam', () => {
    it('sets isArchived to false', () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 't1', isArchived: true })] })
      useTeamStore.getState().unarchiveTeam('t1')
      expect(useTeamStore.getState().teams[0]!.isArchived).toBe(false)
    })
  })
})
