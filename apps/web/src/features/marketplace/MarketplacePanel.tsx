import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Blocks, Bot, SearchX, ShoppingBag, Users, Wrench } from 'lucide-react'
import { apiFetch } from '@clawboo/control-client'
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
import { BUILTIN_SKILLS, searchCatalog } from './catalog'
import type { CatalogSkill } from './catalog'
import { AgentPickerDropdown } from './AgentPickerDropdown'
import { CollapsiblePillRow } from './CollapsiblePillRow'
import type { SkillCategory } from '@/features/graph/types'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import type { TeamTemplate, ProfileLike, TemplateCategory } from '@/features/teams/types'
import { buildTeamCountByAgent, getAgentsForSkill, searchAgentCatalog } from './teamCatalog'
import type { AgentIndexEntry, CatalogIndex } from './catalogTypes'
import { useCatalogIndex } from './useCatalog'
import { COMMUNITY_DISCLOSURE } from './provenance'
import { HeroTile } from './HeroTile'
import {
  TeamShowcaseGrid,
  teamCategoryOptions,
  agentCategoryOptions,
  filterTeams,
  packFilterEntries,
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
    const res = await apiFetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: skill.id,
        name: skill.name,
        // Curated in-repo catalog — no external registry, no vetting.
        source: 'curated',
        category: skill.category,
        agentId,
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
      category: skill.category,
      installedAt: Date.now(),
      agentIds: [agentId],
    }
    useMarketplaceStore.getState().markInstalled(skill.id, agentId, record)

    useGraphStore.getState().triggerRefresh()

    useToastStore.getState().addToast({
      message: `Added "${skill.name}" to ${agentName}'s tool profile`,
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

function SkillCard({
  skill,
  index,
  catalog,
}: {
  skill: CatalogSkill
  index: number
  catalog: CatalogIndex | null
}) {
  const [showPicker, setShowPicker] = useState(false)
  const cat = CATEGORY_META[skill.category] ?? CATEGORY_META.other
  const agentCount = useMemo(
    () => (catalog ? getAgentsForSkill(catalog, skill.id).length : 0),
    [catalog, skill.id],
  )

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
      {/* Top row: dot + name + curated tag */}
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: cat.color }} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">
          {skill.name}
        </span>
        <span
          className="whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground"
          style={{ letterSpacing: '0.03em' }}
          title="Hand-picked clawboo catalog skill"
        >
          Curated
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

      {/* Bottom row: usage + add */}
      <div className="flex items-center gap-2">
        {agentCount > 0 ? (
          <button
            onClick={onAgentCountClick}
            title="Browse agents using this skill"
            className="min-w-0 flex-1 cursor-pointer truncate border-none bg-transparent p-0 text-left text-[10.5px] text-mint/70 transition-colors hover:text-mint hover:underline"
          >
            Used by {agentCount} agent{agentCount === 1 ? '' : 's'}
          </button>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            setShowPicker((v) => !v)
          }}
        >
          Add
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

// ─── MarketplacePanel ────────────────────────────────────────────────────────

export function MarketplacePanel() {
  // One fetch for the whole panel. The index starts as the compiled seed, so the
  // shell, the tab row and the grids all render on the first frame and only the
  // fresher content lands late. `counts` comes from the index so the tab badges
  // stay synchronous.
  const { index: catalog, error: catalogError, retry: retryCatalog } = useCatalogIndex()
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
  const agentCategoryFilter = useMarketplaceStore((s) => s.agentCategoryFilter)
  const setAgentCategoryFilter = useMarketplaceStore((s) => s.setAgentCategoryFilter)
  const agentSourceFilter = useMarketplaceStore((s) => s.agentSourceFilter)
  const setAgentSourceFilter = useMarketplaceStore((s) => s.setAgentSourceFilter)

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [prefilledProfile, setPrefilledProfile] = useState<ProfileLike | null>(null)
  // "Start from scratch" opens CreateTeamModal directly on a blank customize step.
  const [startBlankTeam, setStartBlankTeam] = useState(false)
  const [detailTemplate, setDetailTemplate] = useState<TeamTemplate | null>(null)
  const [detailAgent, setDetailAgent] = useState<AgentIndexEntry | null>(null)

  // Filtered teams + category options — the shared helpers, so the Marketplace
  // and the first-run team modal filter identically.
  const filteredTeams = useMemo(
    () =>
      catalog ? filterTeams(catalog, teamSearchQuery, teamCategoryFilter, teamSourceFilter) : [],
    [catalog, teamSearchQuery, teamCategoryFilter, teamSourceFilter],
  )
  const teamCategoryOpts = useMemo(() => (catalog ? teamCategoryOptions(catalog) : []), [catalog])
  // Built once per index load. `AgentCard` renders this 304 times, and deriving it
  // inside the card would be an O(agents x teams) scan per render.
  const teamCountByAgent = useMemo(
    () => (catalog ? buildTeamCountByAgent(catalog) : new Map<string, number>()),
    [catalog],
  )

  // Agent category options, busiest first, derived from the loaded index.
  const agentCategoryOpts = useMemo(() => (catalog ? agentCategoryOptions(catalog) : []), [catalog])

  // Pack filter entries, derived the same way. Shared by both browse tabs.
  const packEntries = useMemo(() => (catalog ? packFilterEntries(catalog) : []), [catalog])

  // Filtered agents
  const filteredAgents = useMemo(() => {
    if (!catalog) return []
    let results: AgentIndexEntry[] = agentSearchQuery
      ? searchAgentCatalog(catalog, agentSearchQuery)
      : catalog.agents
    if (agentCategoryFilter !== 'all') {
      results = results.filter((a) => a.category === agentCategoryFilter)
    }
    if (agentSourceFilter !== 'all') {
      results = results.filter((a) => a.packId === agentSourceFilter)
    }
    return results
  }, [catalog, agentSearchQuery, agentCategoryFilter, agentSourceFilter])

  // Single-agent deploy — wrap the agent in an adhoc TeamTemplate so CreateTeamModal
  // can drive the existing deploy pipeline (skip pick step, prefill customize step).
  const handleAgentDeploy = (agent: AgentIndexEntry) => {
    const profile: TeamTemplate = {
      id: `adhoc-${agent.id}`,
      name: agent.role,
      emoji: agent.emoji,
      color: agent.color,
      description: agent.description,
      category: agent.category,
      packId: agent.packId,
      source: agent.source,
      tags: agent.tags,
      agentIds: [agent.id],
    }
    setPrefilledProfile(profile)
    setShowCreateModal(true)
  }

  // Filtered skills
  const filteredSkills = useMemo(() => {
    let results: CatalogSkill[] = searchQuery ? searchCatalog(searchQuery) : [...BUILTIN_SKILLS]

    if (categoryFilter !== 'all') {
      results = results.filter((s) => s.category === categoryFilter)
    }

    switch (sortBy) {
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
                onChange={(v) => setSortBy(v as 'name' | 'category')}
                options={[
                  { value: 'name', label: 'Name A–Z' },
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
          Connectors left this row and became its own sidebar destination: the
          other three are a shop you visit once, and connecting the tools your
          agents use is a recurring errand that was three clicks deep here.
          `pt-3` gives the tab row breathing room below the header hairline so the
          space above the labels matches the space below them. */}
      <div className="shrink-0 px-6 pt-3">
        <Tabs
          value={marketplaceTab}
          onChange={(id) => setMarketplaceTab(id)}
          tabs={[
            { id: 'teams', label: 'Teams', icon: Users, count: catalog?.counts.teams ?? 0 },
            { id: 'agents', label: 'Agents', icon: Bot, count: catalog?.counts.agents ?? 0 },
            { id: 'skills', label: 'Skills', icon: Wrench, count: BUILTIN_SKILLS.length },
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

            {/* Team category pills: busiest inline, the rest under "+N more" */}
            <CollapsiblePillRow
              aria-label="Filter teams by category"
              options={teamCategoryOpts}
              activeKey={teamCategoryFilter}
              onSelect={(k) => setTeamCategoryFilter(k as TemplateCategory | 'all')}
            />

            {/* Pack pills, derived from the packs the index actually contains */}
            <div className="flex flex-wrap gap-1.5">
              {packEntries.map((src) => (
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

            {/* Agent category pills: busiest inline, the rest under "+N more" */}
            <CollapsiblePillRow
              aria-label="Filter agents by category"
              options={agentCategoryOpts}
              activeKey={agentCategoryFilter}
              onSelect={(k) => setAgentCategoryFilter(k as TemplateCategory | 'all')}
            />

            {/* Pack pills, derived from the packs the index actually contains */}
            <div className="flex flex-wrap gap-1.5">
              {packEntries.map((src) => (
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
        {/* Said once, plainly, on every catalog tab. Most of what is below is
            other people's work that Clawboo curated and adapted, not wrote, and
            the checks it ran are narrower than a reader might assume. Not
            dismissible: it is a standing fact about the catalog, not a notice to
            acknowledge and hide. */}
        <p className="mb-4 text-[11.5px] leading-relaxed text-muted-foreground">
          {COMMUNITY_DISCLOSURE}
        </p>
        {/* A dropped catalog fetch must say so, but it must NOT empty the grids.
            The builtin pack is compiled into this bundle, so what renders below
            is the seed rather than nothing, and this line is the difference
            between "these are all the teams" and "these are the ones that
            survived". Skills are unaffected: they are a direct import. */}
        {catalogError && (isTeamsTab || isAgentsTab) && (
          <div
            className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-2.5"
            role="status"
          >
            <span className="text-xs text-muted-foreground">
              <span style={{ color: 'var(--amber)' }}>Showing the built-in teams only.</span>{' '}
              {catalogError.message}
            </span>
            <Button variant="secondary" size="sm" onClick={retryCatalog}>
              Try again
            </Button>
          </div>
        )}
        {isTeamsTab && (
          <TeamShowcaseGrid
            catalog={catalog}
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
                    setAgentCategoryFilter('all')
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
                  catalog={catalog}
                  agent={agent}
                  index={i}
                  teamCount={teamCountByAgent.get(agent.id) ?? 0}
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
                subtitle="Curated skills you can add to any Boo's tool profile."
              />
              {filteredSkills.map((skill, i) => (
                <SkillCard key={skill.id} skill={skill} index={i} catalog={catalog} />
              ))}
            </div>
          ))}
      </div>

      {/* Detail modals */}
      {detailTemplate && catalog && (
        <TeamTemplateDetail
          catalog={catalog}
          template={detailTemplate}
          onClose={() => setDetailTemplate(null)}
          onDeploy={(t) => {
            setPrefilledProfile(t)
            setShowCreateModal(true)
            setDetailTemplate(null)
          }}
        />
      )}

      {detailAgent && catalog && (
        <AgentTemplateDetail
          catalog={catalog}
          agent={detailAgent}
          onClose={() => setDetailAgent(null)}
          onDeploy={(a) => {
            handleAgentDeploy(a)
            setDetailAgent(null)
          }}
          onSkillClick={(skillId) => {
            const skill = BUILTIN_SKILLS.find((s) => s.id === skillId)
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
