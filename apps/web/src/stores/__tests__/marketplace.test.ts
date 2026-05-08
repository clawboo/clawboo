import { describe, it, expect, beforeEach } from 'vitest'
import { useMarketplaceStore } from '../marketplace'
import type { InstalledSkillRecord } from '../marketplace'

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<InstalledSkillRecord> = {}): InstalledSkillRecord {
  return {
    skillId: 'test-skill',
    name: 'Test Skill',
    source: 'verified',
    category: 'code',
    trustScore: 90,
    installedAt: Date.now(),
    agentIds: ['agent-1'],
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('useMarketplaceStore', () => {
  beforeEach(() => {
    useMarketplaceStore.setState({
      installedByAgent: new Map(),
      installedSkills: [],
      isLoading: false,
      searchQuery: '',
      categoryFilter: 'all',
      sortBy: 'name',
      marketplaceTab: 'agents',
      teamSearchQuery: '',
      teamCategoryFilter: 'all',
      teamSourceFilter: 'all',
      agentSearchQuery: '',
      agentDomainFilter: 'all',
      agentSourceFilter: 'all',
      agentCategoryFilter: 'all',
    })
  })

  it('starts with correct defaults', () => {
    const state = useMarketplaceStore.getState()
    expect(state.installedByAgent.size).toBe(0)
    expect(state.installedSkills).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.searchQuery).toBe('')
    expect(state.categoryFilter).toBe('all')
    expect(state.sortBy).toBe('name')
    expect(state.marketplaceTab).toBe('agents')
    expect(state.teamSearchQuery).toBe('')
    expect(state.teamCategoryFilter).toBe('all')
    expect(state.teamSourceFilter).toBe('all')
    expect(state.agentSearchQuery).toBe('')
    expect(state.agentDomainFilter).toBe('all')
    expect(state.agentSourceFilter).toBe('all')
    expect(state.agentCategoryFilter).toBe('all')
  })

  // ── Tab ────────────────────────────────────────────────────────────────────

  describe('setMarketplaceTab', () => {
    it('switches to skills tab', () => {
      useMarketplaceStore.getState().setMarketplaceTab('skills')
      expect(useMarketplaceStore.getState().marketplaceTab).toBe('skills')
    })

    it('switches to teams tab', () => {
      useMarketplaceStore.getState().setMarketplaceTab('teams')
      expect(useMarketplaceStore.getState().marketplaceTab).toBe('teams')
    })

    it('switches to agents tab', () => {
      useMarketplaceStore.getState().setMarketplaceTab('skills')
      useMarketplaceStore.getState().setMarketplaceTab('agents')
      expect(useMarketplaceStore.getState().marketplaceTab).toBe('agents')
    })
  })

  // ── Team filters ──────────────────────────────────────────────────────────

  describe('setTeamSearchQuery', () => {
    it('sets team search query', () => {
      useMarketplaceStore.getState().setTeamSearchQuery('engineering')
      expect(useMarketplaceStore.getState().teamSearchQuery).toBe('engineering')
    })

    it('clears with empty string', () => {
      useMarketplaceStore.getState().setTeamSearchQuery('test')
      useMarketplaceStore.getState().setTeamSearchQuery('')
      expect(useMarketplaceStore.getState().teamSearchQuery).toBe('')
    })
  })

  describe('setTeamCategoryFilter', () => {
    it('sets a category filter', () => {
      useMarketplaceStore.getState().setTeamCategoryFilter('engineering')
      expect(useMarketplaceStore.getState().teamCategoryFilter).toBe('engineering')
    })

    it('resets to all', () => {
      useMarketplaceStore.getState().setTeamCategoryFilter('marketing')
      useMarketplaceStore.getState().setTeamCategoryFilter('all')
      expect(useMarketplaceStore.getState().teamCategoryFilter).toBe('all')
    })
  })

  describe('setTeamSourceFilter', () => {
    it('sets a source filter', () => {
      useMarketplaceStore.getState().setTeamSourceFilter('agency-agents')
      expect(useMarketplaceStore.getState().teamSourceFilter).toBe('agency-agents')
    })

    it('resets to all', () => {
      useMarketplaceStore.getState().setTeamSourceFilter('clawboo')
      useMarketplaceStore.getState().setTeamSourceFilter('all')
      expect(useMarketplaceStore.getState().teamSourceFilter).toBe('all')
    })
  })

  // ── Agent filters ─────────────────────────────────────────────────────────

  describe('setAgentSearchQuery', () => {
    it('sets agent search query', () => {
      useMarketplaceStore.getState().setAgentSearchQuery('backend')
      expect(useMarketplaceStore.getState().agentSearchQuery).toBe('backend')
    })

    it('clears with empty string', () => {
      useMarketplaceStore.getState().setAgentSearchQuery('foo')
      useMarketplaceStore.getState().setAgentSearchQuery('')
      expect(useMarketplaceStore.getState().agentSearchQuery).toBe('')
    })
  })

  describe('setAgentDomainFilter', () => {
    it('sets a domain filter', () => {
      useMarketplaceStore.getState().setAgentDomainFilter('engineering')
      expect(useMarketplaceStore.getState().agentDomainFilter).toBe('engineering')
    })

    it('resets to all', () => {
      useMarketplaceStore.getState().setAgentDomainFilter('marketing')
      useMarketplaceStore.getState().setAgentDomainFilter('all')
      expect(useMarketplaceStore.getState().agentDomainFilter).toBe('all')
    })
  })

  describe('setAgentSourceFilter', () => {
    it('sets a source filter', () => {
      useMarketplaceStore.getState().setAgentSourceFilter('agency-agents')
      expect(useMarketplaceStore.getState().agentSourceFilter).toBe('agency-agents')
    })

    it('resets to all', () => {
      useMarketplaceStore.getState().setAgentSourceFilter('clawboo')
      useMarketplaceStore.getState().setAgentSourceFilter('all')
      expect(useMarketplaceStore.getState().agentSourceFilter).toBe('all')
    })
  })

  describe('setAgentCategoryFilter', () => {
    it('sets a category filter', () => {
      useMarketplaceStore.getState().setAgentCategoryFilter('engineering')
      expect(useMarketplaceStore.getState().agentCategoryFilter).toBe('engineering')
    })

    it('resets to all', () => {
      useMarketplaceStore.getState().setAgentCategoryFilter('marketing')
      useMarketplaceStore.getState().setAgentCategoryFilter('all')
      expect(useMarketplaceStore.getState().agentCategoryFilter).toBe('all')
    })
  })

  // ── Hydrate ───────────────────────────────────────────────────────────────

  describe('hydrateInstalled', () => {
    it('replaces installed skills and rebuilds index', () => {
      const records = [
        makeRecord({ skillId: 's1', agentIds: ['a1', 'a2'] }),
        makeRecord({ skillId: 's2', agentIds: ['a1'] }),
      ]
      useMarketplaceStore.getState().hydrateInstalled(records)

      const state = useMarketplaceStore.getState()
      expect(state.installedSkills).toEqual(records)
      expect(state.installedByAgent.get('a1')).toEqual(new Set(['s1', 's2']))
      expect(state.installedByAgent.get('a2')).toEqual(new Set(['s1']))
    })

    it('handles empty records', () => {
      useMarketplaceStore.getState().hydrateInstalled([makeRecord()])
      useMarketplaceStore.getState().hydrateInstalled([])

      const state = useMarketplaceStore.getState()
      expect(state.installedSkills).toEqual([])
      expect(state.installedByAgent.size).toBe(0)
    })
  })

  // ── Mark installed ────────────────────────────────────────────────────────

  describe('markInstalled', () => {
    it('adds new skill record', () => {
      const record = makeRecord({ skillId: 'skill-a', agentIds: ['a1'] })
      useMarketplaceStore.getState().markInstalled('skill-a', 'a1', record)

      const state = useMarketplaceStore.getState()
      expect(state.installedSkills).toHaveLength(1)
      expect(state.installedSkills[0].skillId).toBe('skill-a')
      expect(state.installedByAgent.get('a1')).toEqual(new Set(['skill-a']))
    })

    it('appends agentId to existing skill record', () => {
      const record = makeRecord({ skillId: 'skill-a', agentIds: ['a1'] })
      useMarketplaceStore.getState().markInstalled('skill-a', 'a1', record)
      useMarketplaceStore.getState().markInstalled('skill-a', 'a2', record)

      const state = useMarketplaceStore.getState()
      expect(state.installedSkills).toHaveLength(1)
      expect(state.installedSkills[0].agentIds).toContain('a1')
      expect(state.installedSkills[0].agentIds).toContain('a2')
      expect(state.installedByAgent.get('a2')).toEqual(new Set(['skill-a']))
    })
  })

  // ── Mark uninstalled ──────────────────────────────────────────────────────

  describe('markUninstalled', () => {
    it('removes agentId from skill record', () => {
      const record = makeRecord({ skillId: 's1', agentIds: ['a1', 'a2'] })
      useMarketplaceStore.getState().hydrateInstalled([record])
      useMarketplaceStore.getState().markUninstalled('s1', 'a1')

      const state = useMarketplaceStore.getState()
      expect(state.installedSkills[0].agentIds).toEqual(['a2'])
      expect(state.installedByAgent.has('a1')).toBe(false)
    })

    it('deletes skill record when no agents remain', () => {
      const record = makeRecord({ skillId: 's1', agentIds: ['a1'] })
      useMarketplaceStore.getState().hydrateInstalled([record])
      useMarketplaceStore.getState().markUninstalled('s1', 'a1')

      const state = useMarketplaceStore.getState()
      expect(state.installedSkills).toHaveLength(0)
    })
  })

  // ── Skill filters ─────────────────────────────────────────────────────────

  describe('setSearchQuery', () => {
    it('sets skill search query', () => {
      useMarketplaceStore.getState().setSearchQuery('bash')
      expect(useMarketplaceStore.getState().searchQuery).toBe('bash')
    })
  })

  describe('setCategoryFilter', () => {
    it('sets skill category filter', () => {
      useMarketplaceStore.getState().setCategoryFilter('web')
      expect(useMarketplaceStore.getState().categoryFilter).toBe('web')
    })
  })

  describe('setSortBy', () => {
    it('sets sort order', () => {
      useMarketplaceStore.getState().setSortBy('trust')
      expect(useMarketplaceStore.getState().sortBy).toBe('trust')
    })
  })

  describe('setLoading', () => {
    it('sets loading flag', () => {
      useMarketplaceStore.getState().setLoading(true)
      expect(useMarketplaceStore.getState().isLoading).toBe(true)
    })
  })
})
