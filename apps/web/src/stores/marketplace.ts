import { create } from 'zustand'
import type { SkillCategory } from '@/features/graph/types'
import type { AgentDomain, TemplateCategory, TemplateSource } from '@/features/teams/types'

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface InstalledSkillRecord {
  /** Skill ID (matches catalog ID and skills table PK) */
  skillId: string
  /** Display name */
  name: string
  /** Skill category */
  category: string | null
  /** Epoch ms when first installed */
  installedAt: number | null
  /** Agent IDs that have this skill installed */
  agentIds: string[]
}

// ─── Store ──────────────────────────────────────────────────────────────────────

export type MarketplaceTab = 'skills' | 'agents' | 'teams' | 'connectors'

export type SortBy = 'name' | 'category'

interface MarketplaceStore {
  /** Per-agent install tracking: agentId → Set of skillIds */
  installedByAgent: Map<string, Set<string>>

  /** All installed skill records (hydrated from GET /api/skills) */
  installedSkills: InstalledSkillRecord[]

  /** Whether initial load from SQLite is in progress */
  isLoading: boolean

  /** Search query for catalog filtering */
  searchQuery: string

  /** Category filter ('all' = show everything) */
  categoryFilter: SkillCategory | 'all'

  /** Sort order for catalog listing */
  sortBy: SortBy

  /** Active marketplace tab */
  marketplaceTab: MarketplaceTab

  /** Search query for team template filtering */
  teamSearchQuery: string

  /** Category filter for team templates */
  teamCategoryFilter: TemplateCategory | 'all'

  /** Source filter for team templates */
  teamSourceFilter: TemplateSource | 'all'

  /** Search query for agent catalog filtering */
  agentSearchQuery: string

  /** Domain filter for agent catalog */
  agentDomainFilter: AgentDomain | 'all'

  /** Source filter for agent catalog */
  agentSourceFilter: TemplateSource | 'all'

  /** Category filter for agent catalog (reserved — not wired to UI yet) */
  agentCategoryFilter: TemplateCategory | 'all'

  /** Search query for the connector directory */
  connectorSearchQuery: string

  /** Category filter for the connector directory. Typed as a plain string so the
   *  store does not take a dependency on @clawboo/connector-catalog: the browser
   *  narrows it at the call site. */
  connectorCategoryFilter: string

  // ─── Actions ────────────────────────────────────────────────────────────────

  /** Replace full installed skills list and rebuild the per-agent Map. */
  hydrateInstalled: (records: InstalledSkillRecord[]) => void

  /** Optimistically mark a skill as installed for an agent. */
  markInstalled: (skillId: string, agentId: string, record: InstalledSkillRecord) => void

  /** Remove an agent from a skill's agentIds (uninstall). */
  markUninstalled: (skillId: string, agentId: string) => void

  setLoading: (v: boolean) => void
  setSearchQuery: (q: string) => void
  setCategoryFilter: (c: SkillCategory | 'all') => void
  setSortBy: (s: SortBy) => void
  setMarketplaceTab: (tab: MarketplaceTab) => void
  setTeamSearchQuery: (q: string) => void
  setTeamCategoryFilter: (c: TemplateCategory | 'all') => void
  setTeamSourceFilter: (s: TemplateSource | 'all') => void
  setAgentSearchQuery: (q: string) => void
  setAgentDomainFilter: (d: AgentDomain | 'all') => void
  setAgentSourceFilter: (s: TemplateSource | 'all') => void
  setAgentCategoryFilter: (c: TemplateCategory | 'all') => void
  setConnectorSearchQuery: (q: string) => void
  /**
   * A connector to open the moment the panel mounts, by slug.
   *
   * Lifted out of `ConnectorsBrowser` local state so any surface can deep-link
   * to one card. The graph needs it, because `Configure` used to drop the reader
   * on a panel with no indication which row was theirs.
   *
   * Cleared by the panel once consumed, so returning to the tab later lands on
   * the shelf rather than re-opening whatever was last linked.
   */
  openConnectorSlug: string | null
  setOpenConnectorSlug: (slug: string | null) => void
  setConnectorCategoryFilter: (c: string) => void
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Build the reverse index Map<agentId, Set<skillId>> from a records array. */
function buildByAgentIndex(records: InstalledSkillRecord[]): Map<string, Set<string>> {
  const byAgent = new Map<string, Set<string>>()
  for (const record of records) {
    for (const agentId of record.agentIds) {
      let set = byAgent.get(agentId)
      if (!set) {
        set = new Set()
        byAgent.set(agentId, set)
      }
      set.add(record.skillId)
    }
  }
  return byAgent
}

// ─── Store ──────────────────────────────────────────────────────────────────────

export const useMarketplaceStore = create<MarketplaceStore>((set) => ({
  installedByAgent: new Map(),
  installedSkills: [],
  isLoading: false,
  searchQuery: '',
  categoryFilter: 'all',
  sortBy: 'name',
  // Teams lead the marketplace (first tab + default landing).
  marketplaceTab: 'teams',
  openConnectorSlug: null,
  teamSearchQuery: '',
  teamCategoryFilter: 'all',
  teamSourceFilter: 'all',
  agentSearchQuery: '',
  agentDomainFilter: 'all',
  agentSourceFilter: 'all',
  agentCategoryFilter: 'all',
  connectorSearchQuery: '',
  connectorCategoryFilter: 'all',

  hydrateInstalled: (records) =>
    set({ installedSkills: records, installedByAgent: buildByAgentIndex(records) }),

  markInstalled: (skillId, agentId, record) =>
    set((state) => {
      // Update installedByAgent
      const nextByAgent = new Map(state.installedByAgent)
      const agentSet = new Set(nextByAgent.get(agentId) ?? [])
      agentSet.add(skillId)
      nextByAgent.set(agentId, agentSet)

      // Update installedSkills
      const existing = state.installedSkills.find((s) => s.skillId === skillId)
      const nextSkills = existing
        ? state.installedSkills.map((s) =>
            s.skillId === skillId ? { ...s, agentIds: [...new Set([...s.agentIds, agentId])] } : s,
          )
        : [...state.installedSkills, record]

      return { installedByAgent: nextByAgent, installedSkills: nextSkills }
    }),

  markUninstalled: (skillId, agentId) =>
    set((state) => {
      // Update installedByAgent
      const nextByAgent = new Map(state.installedByAgent)
      const agentSet = nextByAgent.get(agentId)
      if (agentSet) {
        const next = new Set(agentSet)
        next.delete(skillId)
        if (next.size === 0) nextByAgent.delete(agentId)
        else nextByAgent.set(agentId, next)
      }

      // Update installedSkills — remove agentId; delete record if no agents left
      const nextSkills = state.installedSkills
        .map((s) =>
          s.skillId === skillId ? { ...s, agentIds: s.agentIds.filter((id) => id !== agentId) } : s,
        )
        .filter((s) => s.agentIds.length > 0)

      return { installedByAgent: nextByAgent, installedSkills: nextSkills }
    }),

  setLoading: (isLoading) => set({ isLoading }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setCategoryFilter: (categoryFilter) => set({ categoryFilter }),
  setSortBy: (sortBy) => set({ sortBy }),
  setMarketplaceTab: (marketplaceTab) => set({ marketplaceTab }),
  setTeamSearchQuery: (teamSearchQuery) => set({ teamSearchQuery }),
  setTeamCategoryFilter: (teamCategoryFilter) => set({ teamCategoryFilter }),
  setTeamSourceFilter: (teamSourceFilter) => set({ teamSourceFilter }),
  setAgentSearchQuery: (agentSearchQuery) => set({ agentSearchQuery }),
  setAgentDomainFilter: (agentDomainFilter) => set({ agentDomainFilter }),
  setAgentSourceFilter: (agentSourceFilter) => set({ agentSourceFilter }),
  setAgentCategoryFilter: (agentCategoryFilter) => set({ agentCategoryFilter }),
  setConnectorSearchQuery: (connectorSearchQuery) => set({ connectorSearchQuery }),
  setOpenConnectorSlug: (openConnectorSlug) => set({ openConnectorSlug }),
  setConnectorCategoryFilter: (connectorCategoryFilter) => set({ connectorCategoryFilter }),
}))
