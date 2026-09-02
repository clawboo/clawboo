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
import { metaFor, sourceMetaFor } from './registry'
import { searchTeamCatalog } from './teamCatalog'
import type { CatalogIndex, TeamIndexEntry } from './catalogTypes'

/** Filter entry for a pill row: 'all' plus one key per value present in the index. */
export interface FilterEntry {
  key: string
  label: string
  color: string
}

/**
 * The pack filter row: All, then every pack the index actually contains, in
 * first-seen order.
 *
 * DERIVED, not declared. `TEAM_SOURCE_ENTRIES` used to be a hardcoded list built
 * by indexing a `Record<TemplateSource, …>`, which only worked while the source
 * union was closed. A third-party pack now shows up here on its own.
 *
 * This row is also what preserves the browse-by-provenance capability that the
 * deleted 15-chip domain filter used to carry: two of that filter's buckets were
 * provenance rather than subject matter.
 */
export function packFilterEntries(index: CatalogIndex): FilterEntry[] {
  const seen = new Set<string>()
  const entries: FilterEntry[] = [{ key: 'all', label: 'All', color: '' }]
  for (const entry of [...index.teams, ...index.agents]) {
    if (seen.has(entry.packId)) continue
    seen.add(entry.packId)
    const meta = sourceMetaFor(entry.packId)
    entries.push({ key: entry.packId, label: meta.label, color: meta.color })
  }
  return entries
}

/**
 * Category options for a pill row, ordered by count (busiest first) and limited
 * to categories that are actually present.
 *
 * Derived from the rows rather than filtered out of a declared list: the
 * category union is open, so a declared list could not name every value a pack
 * might bring, and `metaFor` gives an unknown one a label and a colour anyway.
 */
function categoryOptions(rows: readonly { category: string }[]): PillOption[] {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => {
      const meta = metaFor(key)
      return { key, label: meta.label, color: meta.color }
    })
}

/** Team category options, busiest first. */
export function teamCategoryOptions(index: CatalogIndex): PillOption[] {
  return categoryOptions(index.teams)
}

/** Agent category options, busiest first. */
export function agentCategoryOptions(index: CatalogIndex): PillOption[] {
  return categoryOptions(index.agents)
}

// Filter the team catalog by the (search, category, pack) triple.
export function filterTeams(
  index: CatalogIndex,
  search: string,
  category: TemplateCategory | 'all',
  packId: TemplateSource | 'all',
): TeamIndexEntry[] {
  let results = search ? searchTeamCatalog(index, search) : index.teams
  if (category !== 'all') results = results.filter((t) => t.category === category)
  if (packId !== 'all') results = results.filter((t) => t.packId === packId)
  return results
}

export interface TeamShowcaseGridProps {
  /** The emitted index, threaded through to each card. `null` while it loads:
   *  the hero and "Start from scratch" still render, because neither needs the
   *  catalog and the blank-team path must not wait on a fetch. */
  catalog: CatalogIndex | null
  teams: TeamTemplate[]
  /** Deploy / pick a template. */
  onSelectTeam: (profile: ProfileLike) => void
  onDetails: (template: TeamTemplate) => void
  /** The "Start from scratch" (blank team) action. */
  onStartFromScratch: () => void
  /** Shown as the empty-state action when no teams match the filters. */
  onClearFilters?: () => void
  /** Whether to render the "Start from scratch" (blank team) card. Defaults to
   *  true; onboarding hides it (a blank team deploys no agents, which would
   *  leave the first-run user with an empty, leaderless workspace). */
  showStartFromScratch?: boolean
}

export function TeamShowcaseGrid({
  catalog,
  teams,
  onSelectTeam,
  onDetails,
  onStartFromScratch,
  onClearFilters,
  showStartFromScratch = true,
}: TeamShowcaseGridProps) {
  // Only an EMPTY RESULT is an empty state. While the index is still loading
  // there is nothing to say "no matches" about yet.
  if (catalog && teams.length === 0) {
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
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}
    >
      <HeroTile
        gradient="var(--grad-violet)"
        icon={Users}
        eyebrow="Workflow teams"
        title="Curated teams, ready to ship"
        subtitle="Deploy a pre-built crew and start collaborating in seconds."
      />
      {/* Start from scratch — the blank-team path, sitting in the one canonical
          team showcase (shown in both the Marketplace and the first-run modal). */}
      {showStartFromScratch && (
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
      )}
      {catalog ? (
        teams.map((profile) => (
          <TeamTemplateCard
            key={profile.id}
            catalog={catalog}
            profile={profile}
            onDeploy={onSelectTeam}
            onDetails={onDetails}
          />
        ))
      ) : (
        <div className="col-span-full py-6 text-center text-[12px] text-muted-foreground">
          Loading teams…
        </div>
      )}
    </div>
  )
}
