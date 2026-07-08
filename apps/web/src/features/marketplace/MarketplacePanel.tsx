import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Blocks, Bot, SearchX, ShoppingBag, Users, Wrench } from 'lucide-react'
import { Select } from '@/features/shared/Select'
import { Button } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { EmptyState } from '@/features/shared/EmptyState'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { SearchInput } from '@/features/shared/SearchInput'
import { Tabs } from '@/features/shared/Tabs'
import { useToastStore } from '@/stores/toast'
import { useMarketplaceStore } from '@/stores/marketplace'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'
import type { InstalledSkillRecord } from '@/stores/marketplace'
import { useGraphStore } from '@/features/graph/store'
import { SKILL_CATALOG, searchCatalog } from './catalog'
import type { CatalogSkill } from './catalog'
import { AgentPickerDropdown } from './AgentPickerDropdown'
import { CollapsiblePillRow, type PillOption } from './CollapsiblePillRow'
import type { SkillCategory } from '@/features/graph/types'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import type {
  TeamTemplate,
  ProfileLike,
  AgentCatalogEntry,
  AgentDomain,
  TemplateCategory,
} from '@/features/teams/types'
import { TEAM_CATALOG, getAgentsForSkill } from './teamCatalog'
import { AGENT_CATALOG, searchAgentCatalog } from './agents'
import { HeroTile } from './HeroTile'
import {
  TeamShowcaseGrid,
  teamCategoryOptions,
  filterTeams,
  TEAM_SOURCE_ENTRIES,
} from './TeamShowcaseGrid'
import { TeamTemplateDetail } from './TeamTemplateDetail'
import { AgentCard } from './AgentCard'
import { AgentTemplateDetail } from './AgentTemplateDetail'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'

// ─── Skill category colours ─────────────────────────────────────────────────
// Token-driven palette shared with SkillNode.tsx via `--category-*`.

const CATEGORY_META: Record<SkillCategory | 'all', { color: string; label: string }> = {
  all: { color: 'var(--foreground)', label: 'All' },
  code: { color: 'var(--category-code)', label: 'Code' },
  file: { color: 'var(--category-file)', label: 'File' },
  web: { color: 'var(--category-web)', label: 'Web' },
  comm: { color: 'var(--category-comm)', label: 'Comm' },
  data: { color: 'var(--category-data)', label: 'Data' },
  other: { color: 'var(--category-other)', label: 'Other' },
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  verified: { label: 'Verified', color: 'var(--category-web)' },
  clawhub: { label: 'Clawboo Marketplace', color: 'var(--category-data)' },
  'skill.sh': { label: 'skill.sh', color: 'var(--category-comm)' },
  local: { label: 'Local', color: 'var(--category-other)' },
}

function trustColor(score: number): string {
  if (score >= 80) return 'var(--mint)'
  if (score >= 50) return 'var(--amber)'
  return 'var(--primary)'
}

// ─── Install skill from marketplace ──────────────────────────────────────────

async function installSkillFromMarketplace(
  skill: CatalogSkill,
  agentId: string,
  agentName: string,
) {
  try {
    // The skills table is the source of truth — the native capability adapter
    // reads it (injection-scanned + audited server-side), so the skill appears on
    // the Ghost Graph + the Capabilities dashboard. (Supersedes the legacy
    // per-agent markdown skill-file write.)
    const res = await fetch('/api/skills', {
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
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      useToastStore.getState().addToast({
        message: `Failed to install "${skill.name}": ${data.error ?? `HTTP ${res.status}`}`,
        type: 'error',
      })
      return
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

// ─── Hero tile ───────────────────────────────────────────────────────────────
// A single colorful, tokenized promo tile at the head of each tab's grid.

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
      className="group relative flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      {/* Top row: dot + name + source badge */}
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: cat.color }}
        />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">
          {skill.name}
        </span>
        <span
          className="whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase"
          style={{
            color: src.color,
            background: `${src.color}18`,
            borderColor: `${src.color}35`,
            letterSpacing: '0.03em',
          }}
        >
          {src.label}
        </span>
      </div>

      {/* Description */}
      <div
        className="text-[12.5px] text-foreground/55"
        style={{
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
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
          <div
            className="h-full rounded-full"
            style={{
              width: `${skill.trustScore}%`,
              background: trustColor(skill.trustScore),
              transition: 'width var(--motion-base)',
            }}
          />
        </div>
        <span className="font-data whitespace-nowrap text-[10px] text-foreground/40">
          {skill.trustScore}%
        </span>
      </div>

      {/* Bottom row: author + version + install */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground/40">
          {skill.author}
          {skill.version && (
            <span className="font-data ml-1.5 text-foreground/25">v{skill.version}</span>
          )}
        </span>
        {agentCount > 0 && (
          <button
            onClick={onAgentCountClick}
            title="Browse agents using this skill"
            className="cursor-pointer whitespace-nowrap border-none bg-transparent p-0 text-[10.5px] text-mint/70 transition-colors hover:text-mint hover:underline"
          >
            Used by {agentCount} agent{agentCount === 1 ? '' : 's'}
          </button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            setShowPicker((v) => !v)
          }}
        >
          Install
        </Button>
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
  openclaw: { label: 'OpenClaw', color: 'var(--primary)' },
  clawboo: { label: 'Clawboo', color: 'var(--mint)' },
}

// The mainstream professional domains people filter by most — shown inline in
// the domain bar; every other (nicher / source-specific) domain folds under the
// "+N more" toggle. Deliberately curated rather than sorted by agent count:
// the source-domains (OpenClaw has 110 agents) would otherwise dominate "top by
// count" and bury the domains users actually browse by.
const POPULAR_DOMAIN_ORDER: AgentDomain[] = [
  'engineering',
  'marketing',
  'design',
  'product',
  'sales',
  'support',
  'specialized',
]

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
  // "Start from scratch" opens CreateTeamModal directly on a blank customize step.
  const [startBlankTeam, setStartBlankTeam] = useState(false)
  const [detailTemplate, setDetailTemplate] = useState<TeamTemplate | null>(null)
  const [detailAgent, setDetailAgent] = useState<AgentCatalogEntry | null>(null)

  // Filtered teams + category options — the shared helpers, so the Marketplace
  // and the first-run team modal filter identically.
  const filteredTeams = useMemo(
    () => filterTeams(teamSearchQuery, teamCategoryFilter, teamSourceFilter),
    [teamSearchQuery, teamCategoryFilter, teamSourceFilter],
  )
  const teamCategoryOpts = useMemo(() => teamCategoryOptions(), [])

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

  // Domain filter options, popular-first: the curated mainstream domains lead,
  // then every remaining present domain in catalog order. Fed to the collapsible
  // pill row (popular inline, the rest under "+N more").
  const domainOptions = useMemo<PillOption[]>(() => {
    const present = new Set(distinctDomains)
    const popular = POPULAR_DOMAIN_ORDER.filter((d) => present.has(d))
    const rest = distinctDomains.filter((d) => !POPULAR_DOMAIN_ORDER.includes(d))
    return [...popular, ...rest].map((d) => ({
      key: d,
      label: AGENT_DOMAIN_META[d].label,
      color: AGENT_DOMAIN_META[d].color,
    }))
  }, [distinctDomains])

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

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <PanelHeader
        title="Marketplace"
        icon={ShoppingBag}
        size="md"
        border
        actions={
          <>
            {/* Sort (skills tab only) */}
            {isSkillsTab && (
              <Select
                size="sm"
                aria-label="Sort skills"
                value={sortBy}
                onChange={(v) => setSortBy(v as 'name' | 'trust' | 'category')}
                options={[
                  { value: 'name', label: 'Name A–Z' },
                  { value: 'trust', label: 'Trust Score' },
                  { value: 'category', label: 'Category' },
                ]}
              />
            )}
            {/* GitHub Star CTA — integrated into the header so this view
                doesn't need the global AppTopBar (which is hidden for
                nav:'marketplace'). */}
            <GitHubStarButton />
          </>
        }
      />

      {/* Tabs — Teams lead (the headline surface), then Agents, then Skills.
          `pt-3` gives the tab row breathing room below the header hairline so the
          space above the labels matches the space below them. */}
      <div className="shrink-0 px-6 pt-3">
        <Tabs
          value={marketplaceTab}
          onChange={(id) => setMarketplaceTab(id)}
          tabs={[
            { id: 'teams', label: 'Teams', icon: Users, count: TEAM_CATALOG.length },
            { id: 'agents', label: 'Agents', icon: Bot, count: AGENT_CATALOG.length },
            { id: 'skills', label: 'Skills', icon: Wrench, count: SKILL_CATALOG.length },
          ]}
        />
      </div>

      {/* Filter bar */}
      <div className="flex shrink-0 flex-col gap-2.5 border-b border-border px-6 py-3.5">
        {isTeamsTab && (
          <>
            {/* Team search */}
            <SearchInput
              size="sm"
              placeholder="Search teams…"
              value={teamSearchQuery}
              onChange={setTeamSearchQuery}
            />

            {/* Team category pills — popular inline, the rest under "+N more" */}
            <CollapsiblePillRow
              aria-label="Filter teams by category"
              options={teamCategoryOpts}
              activeKey={teamCategoryFilter}
              onSelect={(k) => setTeamCategoryFilter(k as TemplateCategory | 'all')}
            />

            {/* Team source pills */}
            <div className="flex flex-wrap gap-1.5">
              {TEAM_SOURCE_ENTRIES.map((src) => (
                <Chip
                  key={src.key}
                  size="sm"
                  active={teamSourceFilter === src.key}
                  accent={src.key === 'all' ? undefined : src.color}
                  onClick={() => setTeamSourceFilter(src.key)}
                >
                  {src.key !== 'all' && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: src.color }}
                    />
                  )}
                  {src.label}
                </Chip>
              ))}
            </div>
          </>
        )}

        {isAgentsTab && (
          <>
            {/* Agent search */}
            <SearchInput
              size="sm"
              placeholder="Search agents…"
              value={agentSearchQuery}
              onChange={setAgentSearchQuery}
            />

            {/* Agent domain pills — popular inline, the rest under "+N more" */}
            <CollapsiblePillRow
              aria-label="Filter agents by domain"
              options={domainOptions}
              activeKey={agentDomainFilter}
              onSelect={(k) => setAgentDomainFilter(k as AgentDomain | 'all')}
            />

            {/* Agent source pills */}
            <div className="flex flex-wrap gap-1.5">
              {TEAM_SOURCE_ENTRIES.map((src) => (
                <Chip
                  key={src.key}
                  size="sm"
                  active={agentSourceFilter === src.key}
                  accent={src.key === 'all' ? undefined : src.color}
                  onClick={() => setAgentSourceFilter(src.key)}
                >
                  {src.key !== 'all' && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: src.color }}
                    />
                  )}
                  {src.label}
                </Chip>
              ))}
            </div>
          </>
        )}

        {isSkillsTab && (
          <>
            {/* Skill search */}
            <SearchInput
              size="sm"
              placeholder="Search skills…"
              value={searchQuery}
              onChange={setSearchQuery}
            />

            {/* Skill category pills */}
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(CATEGORY_META) as (SkillCategory | 'all')[]).map((key) => {
                const { color, label } = CATEGORY_META[key]
                return (
                  <Chip
                    key={key}
                    size="sm"
                    active={categoryFilter === key}
                    accent={key === 'all' ? undefined : color}
                    onClick={() => setCategoryFilter(key)}
                  >
                    {label}
                  </Chip>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {isTeamsTab && (
          <TeamShowcaseGrid
            teams={filteredTeams}
            onSelectTeam={(p) => {
              setPrefilledProfile(p)
              setShowCreateModal(true)
            }}
            onDetails={(t) => setDetailTemplate(t)}
            onStartFromScratch={() => {
              setPrefilledProfile(null)
              setStartBlankTeam(true)
              setShowCreateModal(true)
            }}
            onClearFilters={() => {
              setTeamSearchQuery('')
              setTeamCategoryFilter('all')
              setTeamSourceFilter('all')
            }}
          />
        )}

        {isAgentsTab &&
          (filteredAgents.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="No agents match your search"
              helper="Try a different keyword or clear the filters."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setAgentSearchQuery('')
                    setAgentDomainFilter('all')
                    setAgentSourceFilter('all')
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}
            >
              <HeroTile
                gradient="var(--grad-rose)"
                icon={Bot}
                eyebrow="First-class agents"
                title="Handpicked agents"
                subtitle="Browse hundreds of specialists and deploy one to its own team."
              />
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
              icon={SearchX}
              title="No skills match your search"
              helper="Try a different keyword or clear the category filter."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSearchQuery('')
                    setCategoryFilter('all')
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
            >
              <HeroTile
                gradient="var(--grad-emerald)"
                icon={Blocks}
                eyebrow="Capability catalog"
                title="Skills for every agent"
                subtitle="Install trusted, injection-scanned capabilities onto your Boos."
              />
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
          setStartBlankTeam(false)
        }}
        onCreated={() => {
          setShowCreateModal(false)
          setPrefilledProfile(null)
          setStartBlankTeam(false)
          // CreateTeamModal selects the newly-created team before firing
          // onCreated — switch the user into its group chat so they can
          // immediately use the team they just deployed from the marketplace.
          const newTeamId = useTeamStore.getState().selectedTeamId
          if (newTeamId) {
            useViewStore.getState().openGroupChat(newTeamId)
          }
        }}
        initialProfile={prefilledProfile}
        startBlank={startBlankTeam}
      />
    </div>
  )
}
