import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { useMarketplaceStore } from '@/stores/marketplace'
import type { InstalledSkillRecord } from '@/stores/marketplace'
import { mutationQueue } from '@/lib/mutationQueue'
import { useGraphStore } from '@/features/graph/store'
import { SKILL_CATALOG, searchCatalog } from './catalog'
import type { CatalogSkill } from './catalog'
import { AgentPickerDropdown } from './AgentPickerDropdown'
import type { SkillCategory } from '@/features/graph/types'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import type {
  TeamTemplate,
  ProfileLike,
  AgentCatalogEntry,
  AgentDomain,
  TemplateSource,
} from '@/features/teams/types'
import {
  TEAM_CATALOG,
  TEMPLATE_CATEGORIES,
  SOURCE_META,
  searchTeamCatalog,
  getAgentsForSkill,
} from './teamCatalog'
import { AGENT_CATALOG, searchAgentCatalog } from './agents'
import { TeamTemplateCard } from './TeamTemplateCard'
import { TeamTemplateDetail } from './TeamTemplateDetail'
import { AgentCard } from './AgentCard'
import { AgentTemplateDetail } from './AgentTemplateDetail'

// ─── Skill category colours (matches SkillNode.tsx) ─────────────────────────

const CATEGORY_META: Record<SkillCategory | 'all', { color: string; label: string }> = {
  all: { color: '#E8E8E8', label: 'All' },
  code: { color: '#F97316', label: 'Code' },
  file: { color: '#FBBF24', label: 'File' },
  web: { color: '#A855F7', label: 'Web' },
  comm: { color: '#34D399', label: 'Comm' },
  data: { color: '#3B82F6', label: 'Data' },
  other: { color: '#6B7280', label: 'Other' },
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  verified: { label: 'Verified', color: '#A855F7' },
  clawhub: { label: 'ClawHub', color: '#3B82F6' },
  'skill.sh': { label: 'skill.sh', color: '#34D399' },
  local: { label: 'Local', color: '#6B7280' },
}

function trustColor(score: number): string {
  if (score >= 80) return '#34D399'
  if (score >= 50) return '#FBBF24'
  return '#E94560'
}

// ─── Install skill from marketplace ──────────────────────────────────────────

async function installSkillFromMarketplace(
  skill: CatalogSkill,
  agentId: string,
  agentName: string,
) {
  const client = useConnectionStore.getState().client
  if (!client) return

  try {
    const currentTools = await client.agents.files.read(agentId, 'TOOLS.md')

    if (currentTools.toLowerCase().includes(skill.name.toLowerCase())) {
      useToastStore.getState().addToast({
        message: `${skill.name} already installed on ${agentName}`,
        type: 'info',
      })
      return
    }

    const newTools = currentTools.trimEnd() + '\n- ' + skill.name + '\n'
    await mutationQueue.enqueue(agentId, () =>
      client.agents.files.set(agentId, 'TOOLS.md', newTools),
    )

    // Persist to SQLite (best-effort)
    try {
      await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: skill.id,
          name: skill.name,
          source: skill.source,
          category: skill.category,
          trustScore: skill.trustScore,
          agentId,
          version: skill.version,
          author: skill.author,
        }),
      })
    } catch {
      // Non-fatal — TOOLS.md is the real source of truth
    }

    // Update marketplace store
    const record: InstalledSkillRecord = {
      skillId: skill.id,
      name: skill.name,
      source: skill.source,
      category: skill.category,
      trustScore: skill.trustScore,
      installedAt: Date.now(),
      agentIds: [agentId],
    }
    useMarketplaceStore.getState().markInstalled(skill.id, agentId, record)

    useGraphStore.getState().triggerRefresh()

    useToastStore.getState().addToast({
      message: `Installed "${skill.name}" on ${agentName}`,
      type: 'success',
    })
  } catch (err) {
    useToastStore.getState().addToast({
      message: `Failed to install: ${err instanceof Error ? err.message : 'unknown'}`,
      type: 'error',
    })
  }
}

// ─── EmptyState ─────────────────────────────────────────────────────────────

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 60,
        gap: 8,
      }}
    >
      <span style={{ fontSize: 28 }}>🔍</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(232,232,232,0.38)' }}>
        {title}
      </span>
      <span
        style={{
          fontSize: 12,
          color: 'rgba(232,232,232,0.25)',
          textAlign: 'center',
          maxWidth: 280,
          lineHeight: 1.6,
        }}
      >
        {hint}
      </span>
    </div>
  )
}

// ─── SkillCard ───────────────────────────────────────────────────────────────

function SkillCard({ skill, index }: { skill: CatalogSkill; index: number }) {
  const [showPicker, setShowPicker] = useState(false)
  const cat = CATEGORY_META[skill.category] ?? CATEGORY_META.other
  const src = SOURCE_LABELS[skill.source] ?? SOURCE_LABELS.local
  const agentCount = useMemo(() => getAgentsForSkill(skill.id).length, [skill.id])

  const onAgentCountClick = () => {
    const store = useMarketplaceStore.getState()
    store.setMarketplaceTab('agents')
    store.setAgentSearchQuery(skill.name)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.03, 0.5) }}
      style={{
        position: 'relative',
        background: '#111827',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: 10,
        padding: '14px 16px',
        transition: 'border-color 0.15s',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)'
      }}
    >
      {/* Top row: dot + name + source badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: cat.color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: '#E8E8E8', flex: 1, minWidth: 0 }}>
          {skill.name}
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: src.color,
            background: `${src.color}18`,
            border: `1px solid ${src.color}35`,
            borderRadius: 4,
            padding: '1px 6px',
            whiteSpace: 'nowrap',
            letterSpacing: '0.03em',
          }}
        >
          {src.label}
        </span>
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 12,
          color: 'rgba(232,232,232,0.55)',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {skill.description}
      </div>

      {/* Trust bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 3,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.06)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${skill.trustScore}%`,
              height: '100%',
              borderRadius: 2,
              background: trustColor(skill.trustScore),
              transition: 'width 0.3s',
            }}
          />
        </div>
        <span style={{ fontSize: 10, color: 'rgba(232,232,232,0.35)', whiteSpace: 'nowrap' }}>
          {skill.trustScore}%
        </span>
      </div>

      {/* Bottom row: author + version + install */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 10,
            color: 'rgba(232,232,232,0.35)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {skill.author}
          {skill.version && (
            <span style={{ marginLeft: 6, color: 'rgba(232,232,232,0.25)' }}>v{skill.version}</span>
          )}
        </span>
        {agentCount > 0 && (
          <button
            onClick={onAgentCountClick}
            title="Browse agents using this skill"
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              fontSize: 10,
              color: 'rgba(52,211,153,0.65)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              textDecoration: 'none',
              transition: 'color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'rgba(52,211,153,0.95)'
              e.currentTarget.style.textDecoration = 'underline'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'rgba(52,211,153,0.65)'
              e.currentTarget.style.textDecoration = 'none'
            }}
          >
            Used by {agentCount} agent{agentCount === 1 ? '' : 's'}
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setShowPicker((v) => !v)
          }}
          style={{
            background: 'rgba(52,211,153,0.15)',
            border: '1px solid rgba(52,211,153,0.35)',
            color: '#34D399',
            fontSize: 11,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 6,
            cursor: 'pointer',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(52,211,153,0.25)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(52,211,153,0.15)'
          }}
        >
          Install
        </button>
      </div>

      {/* Agent picker */}
      {showPicker && (
        <AgentPickerDropdown
          onSelect={(agentId, agentName) => {
            void installSkillFromMarketplace(skill, agentId, agentName)
          }}
          onClose={() => setShowPicker(false)}
          style={{ top: '100%', right: 0, marginTop: 4 }}
        />
      )}
    </motion.div>
  )
}

// ─── Source filter entries ───────────────────────────────────────────────────

const SOURCE_ENTRIES: { key: TemplateSource | 'all'; label: string; color: string }[] = [
  { key: 'all', label: 'All', color: '#E8E8E8' },
  { key: 'clawboo', label: SOURCE_META.clawboo.label, color: SOURCE_META.clawboo.color },
  {
    key: 'agency-agents',
    label: SOURCE_META['agency-agents'].label,
    color: SOURCE_META['agency-agents'].color,
  },
  {
    key: 'awesome-openclaw',
    label: SOURCE_META['awesome-openclaw'].label,
    color: SOURCE_META['awesome-openclaw'].color,
  },
]

// ─── Agent domain metadata ───────────────────────────────────────────────────

const AGENT_DOMAIN_META: Record<AgentDomain, { label: string; color: string }> = {
  academic: { label: 'Academic', color: '#A855F7' },
  design: { label: 'Design', color: '#EC4899' },
  engineering: { label: 'Engineering', color: '#3B82F6' },
  'game-development': { label: 'Game Dev', color: '#8B5CF6' },
  marketing: { label: 'Marketing', color: '#F59E0B' },
  'paid-media': { label: 'Paid Media', color: '#F97316' },
  product: { label: 'Product', color: '#06B6D4' },
  'project-management': { label: 'Project Mgmt', color: '#0EA5E9' },
  sales: { label: 'Sales', color: '#10B981' },
  'spatial-computing': { label: 'Spatial', color: '#6366F1' },
  specialized: { label: 'Specialized', color: '#64748B' },
  support: { label: 'Support', color: '#14B8A6' },
  testing: { label: 'Testing', color: '#EAB308' },
  openclaw: { label: 'OpenClaw', color: '#E94560' },
  clawboo: { label: 'Clawboo', color: '#34D399' },
}

// ─── MarketplacePanel ────────────────────────────────────────────────────────

export function MarketplacePanel() {
  // Skill filter state
  const searchQuery = useMarketplaceStore((s) => s.searchQuery)
  const setSearchQuery = useMarketplaceStore((s) => s.setSearchQuery)
  const categoryFilter = useMarketplaceStore((s) => s.categoryFilter)
  const setCategoryFilter = useMarketplaceStore((s) => s.setCategoryFilter)
  const sortBy = useMarketplaceStore((s) => s.sortBy)
  const setSortBy = useMarketplaceStore((s) => s.setSortBy)

  // Tab + team filter state
  const marketplaceTab = useMarketplaceStore((s) => s.marketplaceTab)
  const setMarketplaceTab = useMarketplaceStore((s) => s.setMarketplaceTab)
  const teamSearchQuery = useMarketplaceStore((s) => s.teamSearchQuery)
  const setTeamSearchQuery = useMarketplaceStore((s) => s.setTeamSearchQuery)
  const teamCategoryFilter = useMarketplaceStore((s) => s.teamCategoryFilter)
  const setTeamCategoryFilter = useMarketplaceStore((s) => s.setTeamCategoryFilter)
  const teamSourceFilter = useMarketplaceStore((s) => s.teamSourceFilter)
  const setTeamSourceFilter = useMarketplaceStore((s) => s.setTeamSourceFilter)

  // Agent filter state
  const agentSearchQuery = useMarketplaceStore((s) => s.agentSearchQuery)
  const setAgentSearchQuery = useMarketplaceStore((s) => s.setAgentSearchQuery)
  const agentDomainFilter = useMarketplaceStore((s) => s.agentDomainFilter)
  const setAgentDomainFilter = useMarketplaceStore((s) => s.setAgentDomainFilter)
  const agentSourceFilter = useMarketplaceStore((s) => s.agentSourceFilter)
  const setAgentSourceFilter = useMarketplaceStore((s) => s.setAgentSourceFilter)

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [prefilledProfile, setPrefilledProfile] = useState<ProfileLike | null>(null)
  const [detailTemplate, setDetailTemplate] = useState<TeamTemplate | null>(null)
  const [detailAgent, setDetailAgent] = useState<AgentCatalogEntry | null>(null)

  // Filtered teams
  const filteredTeams = useMemo(() => {
    let results = teamSearchQuery ? searchTeamCatalog(teamSearchQuery) : [...TEAM_CATALOG]
    if (teamCategoryFilter !== 'all') {
      results = results.filter((t) => t.category === teamCategoryFilter)
    }
    if (teamSourceFilter !== 'all') {
      results = results.filter((t) => t.source === teamSourceFilter)
    }
    return results
  }, [teamSearchQuery, teamCategoryFilter, teamSourceFilter])

  // Active template categories (only those with >=1 template)
  const activeCategories = useMemo(() => {
    const catSet = new Set(TEAM_CATALOG.map((t) => t.category))
    return TEMPLATE_CATEGORIES.filter((c) => catSet.has(c.key))
  }, [])

  // Distinct agent domains present in the catalog, ordered by first-seen
  const distinctDomains = useMemo(() => {
    const seen = new Set<AgentDomain>()
    const ordered: AgentDomain[] = []
    for (const a of AGENT_CATALOG) {
      if (!seen.has(a.domain)) {
        seen.add(a.domain)
        ordered.push(a.domain)
      }
    }
    return ordered
  }, [])

  // Filtered agents
  const filteredAgents = useMemo(() => {
    let results: AgentCatalogEntry[] = agentSearchQuery
      ? searchAgentCatalog(agentSearchQuery)
      : [...AGENT_CATALOG]
    if (agentDomainFilter !== 'all') {
      results = results.filter((a) => a.domain === agentDomainFilter)
    }
    if (agentSourceFilter !== 'all') {
      results = results.filter((a) => a.source === agentSourceFilter)
    }
    return results
  }, [agentSearchQuery, agentDomainFilter, agentSourceFilter])

  // Single-agent deploy — wrap the agent in an adhoc TeamTemplate so CreateTeamModal
  // can drive the existing deploy pipeline (skip pick step, prefill customize step).
  const handleAgentDeploy = (agent: AgentCatalogEntry) => {
    const profile: TeamTemplate = {
      id: `adhoc-${agent.id}`,
      name: agent.role,
      emoji: agent.emoji,
      color: agent.color,
      description: agent.description,
      category: agent.category,
      source: agent.source,
      tags: agent.tags,
      agentIds: [agent.id],
    }
    setPrefilledProfile(profile)
    setShowCreateModal(true)
  }

  // Filtered skills
  const filteredSkills = useMemo(() => {
    let results: CatalogSkill[] = searchQuery ? searchCatalog(searchQuery) : [...SKILL_CATALOG]

    if (categoryFilter !== 'all') {
      results = results.filter((s) => s.category === categoryFilter)
    }

    switch (sortBy) {
      case 'trust':
        results.sort((a, b) => b.trustScore - a.trustScore)
        break
      case 'category':
        results.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
        break
      case 'name':
      default:
        results.sort((a, b) => a.name.localeCompare(b.name))
        break
    }

    return results
  }, [searchQuery, categoryFilter, sortBy])

  const isAgentsTab = marketplaceTab === 'agents'
  const isTeamsTab = marketplaceTab === 'teams'
  const isSkillsTab = marketplaceTab === 'skills'

  const tabButton = (tab: 'skills' | 'agents' | 'teams', label: string, count: number) => {
    const active = marketplaceTab === tab
    return (
      <button
        key={tab}
        onClick={() => setMarketplaceTab(tab)}
        style={{
          background: active ? 'rgba(52,211,153,0.15)' : 'transparent',
          border: active ? '1px solid rgba(52,211,153,0.35)' : '1px solid rgba(255,255,255,0.06)',
          color: active ? '#34D399' : 'rgba(232,232,232,0.45)',
          borderRadius: 12,
          padding: '2px 10px',
          fontSize: 11,
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'all 0.15s',
          whiteSpace: 'nowrap',
        }}
      >
        {label} ({count})
      </button>
    )
  }

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0A0E1A' }}
    >
      {/* Toolbar */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#E8E8E8' }}>Marketplace</span>

          {/* Tab toggle */}
          <div style={{ display: 'flex', gap: 4 }}>
            {tabButton('skills', 'Skills', SKILL_CATALOG.length)}
            {tabButton('agents', 'Agents', AGENT_CATALOG.length)}
            {tabButton('teams', 'Teams', TEAM_CATALOG.length)}
          </div>
        </div>

        {/* Sort (skills tab only) */}
        {isSkillsTab && (
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'name' | 'trust' | 'category')}
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
              color: 'rgba(232,232,232,0.6)',
              fontSize: 11,
              padding: '3px 8px',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="name">Name A–Z</option>
            <option value="trust">Trust Score</option>
            <option value="category">Category</option>
          </select>
        )}
      </div>

      {/* Filter bar */}
      <div
        style={{
          flexShrink: 0,
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
        }}
      >
        {isTeamsTab && (
          <>
            {/* Team search */}
            <div style={{ position: 'relative' }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'rgba(232,232,232,0.3)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                placeholder="Search teams…"
                value={teamSearchQuery}
                onChange={(e) => setTeamSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px 6px 32px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 6,
                  color: '#E8E8E8',
                  fontSize: 12,
                  outline: 'none',
                }}
              />
            </div>

            {/* Team category pills */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <button
                onClick={() => setTeamCategoryFilter('all')}
                style={{
                  background:
                    teamCategoryFilter === 'all' ? 'rgba(232,232,232,0.12)' : 'transparent',
                  border:
                    teamCategoryFilter === 'all'
                      ? '1px solid rgba(232,232,232,0.3)'
                      : '1px solid rgba(255,255,255,0.06)',
                  color: teamCategoryFilter === 'all' ? '#E8E8E8' : 'rgba(232,232,232,0.45)',
                  borderRadius: 12,
                  padding: '3px 10px',
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                All
              </button>
              {activeCategories.map((cat) => {
                const isActive = teamCategoryFilter === cat.key
                return (
                  <button
                    key={cat.key}
                    onClick={() => setTeamCategoryFilter(cat.key)}
                    style={{
                      background: isActive ? `${cat.color}20` : 'transparent',
                      border: isActive
                        ? `1px solid ${cat.color}55`
                        : '1px solid rgba(255,255,255,0.06)',
                      color: isActive ? cat.color : 'rgba(232,232,232,0.45)',
                      borderRadius: 12,
                      padding: '3px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cat.label}
                  </button>
                )
              })}
            </div>

            {/* Team source pills */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {SOURCE_ENTRIES.map((src) => {
                const isActive = teamSourceFilter === src.key
                return (
                  <button
                    key={src.key}
                    onClick={() => setTeamSourceFilter(src.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      background: isActive ? `${src.color}20` : 'transparent',
                      border: isActive
                        ? `1px solid ${src.color}55`
                        : '1px solid rgba(255,255,255,0.06)',
                      color: isActive ? src.color : 'rgba(232,232,232,0.45)',
                      borderRadius: 12,
                      padding: '3px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {src.key !== 'all' && (
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: src.color,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {src.label}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {isAgentsTab && (
          <>
            {/* Agent search */}
            <div style={{ position: 'relative' }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'rgba(232,232,232,0.3)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                placeholder="Search agents…"
                value={agentSearchQuery}
                onChange={(e) => setAgentSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px 6px 32px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 6,
                  color: '#E8E8E8',
                  fontSize: 12,
                  outline: 'none',
                }}
              />
            </div>

            {/* Agent domain pills */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <button
                onClick={() => setAgentDomainFilter('all')}
                style={{
                  background:
                    agentDomainFilter === 'all' ? 'rgba(232,232,232,0.12)' : 'transparent',
                  border:
                    agentDomainFilter === 'all'
                      ? '1px solid rgba(232,232,232,0.3)'
                      : '1px solid rgba(255,255,255,0.06)',
                  color: agentDomainFilter === 'all' ? '#E8E8E8' : 'rgba(232,232,232,0.45)',
                  borderRadius: 12,
                  padding: '3px 10px',
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                All
              </button>
              {distinctDomains.map((domain) => {
                const meta = AGENT_DOMAIN_META[domain]
                const isActive = agentDomainFilter === domain
                return (
                  <button
                    key={domain}
                    onClick={() => setAgentDomainFilter(domain)}
                    style={{
                      background: isActive ? `${meta.color}20` : 'transparent',
                      border: isActive
                        ? `1px solid ${meta.color}55`
                        : '1px solid rgba(255,255,255,0.06)',
                      color: isActive ? meta.color : 'rgba(232,232,232,0.45)',
                      borderRadius: 12,
                      padding: '3px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {meta.label}
                  </button>
                )
              })}
            </div>

            {/* Agent source pills */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {SOURCE_ENTRIES.map((src) => {
                const isActive = agentSourceFilter === src.key
                return (
                  <button
                    key={src.key}
                    onClick={() => setAgentSourceFilter(src.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      background: isActive ? `${src.color}20` : 'transparent',
                      border: isActive
                        ? `1px solid ${src.color}55`
                        : '1px solid rgba(255,255,255,0.06)',
                      color: isActive ? src.color : 'rgba(232,232,232,0.45)',
                      borderRadius: 12,
                      padding: '3px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {src.key !== 'all' && (
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: src.color,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {src.label}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {isSkillsTab && (
          <>
            {/* Skill search */}
            <div style={{ position: 'relative' }}>
              <Search
                size={14}
                style={{
                  position: 'absolute',
                  left: 10,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'rgba(232,232,232,0.3)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                placeholder="Search skills…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '6px 10px 6px 32px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: 6,
                  color: '#E8E8E8',
                  fontSize: 12,
                  outline: 'none',
                }}
              />
            </div>

            {/* Skill category pills */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(Object.keys(CATEGORY_META) as (SkillCategory | 'all')[]).map((key) => {
                const isActive = categoryFilter === key
                const { color, label } = CATEGORY_META[key]
                return (
                  <button
                    key={key}
                    onClick={() => setCategoryFilter(key)}
                    style={{
                      background: isActive ? `${color}20` : 'transparent',
                      border: isActive
                        ? `1px solid ${color}55`
                        : '1px solid rgba(255,255,255,0.06)',
                      color: isActive ? color : 'rgba(232,232,232,0.45)',
                      borderRadius: 12,
                      padding: '3px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Grid */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 12,
        }}
      >
        {isTeamsTab &&
          (filteredTeams.length === 0 ? (
            <EmptyState
              title="No teams match your search"
              hint="Try a different keyword or clear the filters."
            />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 10,
              }}
            >
              {filteredTeams.map((profile) => (
                <TeamTemplateCard
                  key={profile.id}
                  profile={profile}
                  onDeploy={(p) => {
                    setPrefilledProfile(p)
                    setShowCreateModal(true)
                  }}
                  onDetails={(t) => setDetailTemplate(t)}
                />
              ))}
            </div>
          ))}

        {isAgentsTab &&
          (filteredAgents.length === 0 ? (
            <EmptyState
              title="No agents match your search"
              hint="Try a different keyword or clear the filters."
            />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 10,
              }}
            >
              {filteredAgents.map((agent, i) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  index={i}
                  onDetails={(a) => setDetailAgent(a)}
                  onDeploy={handleAgentDeploy}
                />
              ))}
            </div>
          ))}

        {isSkillsTab &&
          (filteredSkills.length === 0 ? (
            <EmptyState
              title="No skills match your search"
              hint="Try a different keyword or clear the category filter."
            />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 10,
              }}
            >
              {filteredSkills.map((skill, i) => (
                <SkillCard key={skill.id} skill={skill} index={i} />
              ))}
            </div>
          ))}
      </div>

      {/* Detail modals */}
      {detailTemplate && (
        <TeamTemplateDetail
          template={detailTemplate}
          onClose={() => setDetailTemplate(null)}
          onDeploy={(t) => {
            setPrefilledProfile(t)
            setShowCreateModal(true)
            setDetailTemplate(null)
          }}
        />
      )}

      {detailAgent && (
        <AgentTemplateDetail
          agent={detailAgent}
          onClose={() => setDetailAgent(null)}
          onDeploy={(a) => {
            handleAgentDeploy(a)
            setDetailAgent(null)
          }}
          onSkillClick={(skillId) => {
            const skill = SKILL_CATALOG.find((s) => s.id === skillId)
            setMarketplaceTab('skills')
            if (skill) setSearchQuery(skill.name)
            setDetailAgent(null)
          }}
          onTeamClick={(team) => {
            setMarketplaceTab('teams')
            setTeamSearchQuery(team.name)
            setDetailAgent(null)
          }}
        />
      )}

      <CreateTeamModal
        isOpen={showCreateModal}
        onClose={() => {
          setShowCreateModal(false)
          setPrefilledProfile(null)
        }}
        onCreated={() => {
          setShowCreateModal(false)
          setPrefilledProfile(null)
        }}
        initialProfile={prefilledProfile}
      />
    </div>
  )
}
