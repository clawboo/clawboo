// The shared "browse teams" grid — one hero banner, a "Start from scratch"
// card, and the TeamTemplateCard grid. Rendered BOTH in the Marketplace Teams
// tab AND inside the first-run "create a team" modal so the two never drift.
//
// It also owns the team-filter helpers (category options + the filter predicate
// + the source entries) so every consumer filters identically.

import { Plus, SearchX, Users } from 'lucide-react'

import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import type {
  ProfileLike,
  TeamTemplate,
  TemplateCategory,
  TemplateSource,
} from '@/features/teams/types'

import type { PillOption } from './CollapsiblePillRow'
import { HeroTile } from './HeroTile'
import { TeamTemplateCard } from './TeamTemplateCard'
import { SOURCE_META, TEAM_CATALOG, TEMPLATE_CATEGORIES, searchTeamCatalog } from './teamCatalog'

// Source filter entries (All + the three catalog sources).
export const TEAM_SOURCE_ENTRIES: { key: TemplateSource | 'all'; label: string; color: string }[] =
  [
    { key: 'all', label: 'All', color: '' },
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

// Team category options, ordered by team count (busiest first). Only categories
// with >= 1 template are included. Fed to the collapsible category pill row.
export function teamCategoryOptions(): PillOption[] {
  const counts = new Map<string, number>()
  for (const t of TEAM_CATALOG) counts.set(t.category, (counts.get(t.category) ?? 0) + 1)
  return TEMPLATE_CATEGORIES.filter((c) => counts.has(c.key))
    .slice()
    .sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0))
    .map((c) => ({ key: c.key, label: c.label, color: c.color }))
}

// Filter the team catalog by the (search, category, source) triple.
export function filterTeams(
  search: string,
  category: TemplateCategory | 'all',
  source: TemplateSource | 'all',
): TeamTemplate[] {
  let results = search ? searchTeamCatalog(search) : [...TEAM_CATALOG]
  if (category !== 'all') results = results.filter((t) => t.category === category)
  if (source !== 'all') results = results.filter((t) => t.source === source)
  return results
}

export interface TeamShowcaseGridProps {
  teams: TeamTemplate[]
  /** Deploy / pick a template. */
  onSelectTeam: (profile: ProfileLike) => void
  onDetails: (template: TeamTemplate) => void
  /** The "Start from scratch" (blank team) action. */
  onStartFromScratch: () => void
  /** Shown as the empty-state action when no teams match the filters. */
  onClearFilters?: () => void
}

export function TeamShowcaseGrid({
  teams,
  onSelectTeam,
  onDetails,
  onStartFromScratch,
  onClearFilters,
}: TeamShowcaseGridProps) {
  if (teams.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No teams match your search"
        helper="Try a different keyword or clear the filters."
        action={
          onClearFilters ? (
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
      <HeroTile
        gradient="var(--grad-violet)"
        icon={Users}
        eyebrow="Workflow teams"
        title="Curated teams, ready to ship"
        subtitle="Deploy a pre-built crew and start collaborating in seconds."
      />
      {/* Start from scratch — the blank-team path, sitting in the one canonical
          team showcase (shown in both the Marketplace and the first-run modal). */}
      <button
        type="button"
        data-testid="team-start-from-scratch"
        onClick={onStartFromScratch}
        className="group flex min-h-[132px] flex-col items-start justify-center gap-3 rounded-2xl border border-dashed border-border-strong bg-transparent p-5 text-left transition-all duration-150 hover:border-primary hover:bg-primary/[0.04]"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground/70 transition-colors duration-150 group-hover:bg-primary/10 group-hover:text-primary">
          <Plus size={18} strokeWidth={2} />
        </span>
        <div>
          <div className="text-[14px] font-semibold text-foreground">Start from scratch</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-foreground/55">
            Build a custom team and add your own agents.
          </div>
        </div>
      </button>
      {teams.map((profile) => (
        <TeamTemplateCard
          key={profile.id}
          profile={profile}
          onDeploy={onSelectTeam}
          onDetails={onDetails}
        />
      ))}
    </div>
  )
}
