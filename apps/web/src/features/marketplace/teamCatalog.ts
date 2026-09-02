// Lookups and resolution over the EMITTED catalog index.
//
// This module used to import `AGENT_CATALOG` and `TEAM_CATALOG` directly, which
// is what pulled 4.2 MB of agent prose into every consumer's chunk. It now takes
// a `CatalogIndex` as a parameter, so nothing here reaches the corpus and the
// browse surfaces render from ~232 KB.
//
// The split that matters:
//
//   resolveTeamRoster  SYNCHRONOUS, index only. id/name/role/emoji/color, which
//                      is everything a CARD renders. Used by the 82-card grid,
//                      so it must never fetch.
//   resolveTeamAgents  ASYNC. Adds the markdown bodies. Used by the detail sheet
//                      and the deploy path only. Bounded fan-out: the largest
//                      team in the catalog has 11 members.

import type {
  AgentTemplate,
  ProfileLike,
  TeamProfile,
  TeamTemplate,
  TemplateCategory,
  TemplateSource,
} from '@/features/teams/types'
import { buildToolsMd } from '@/lib/createAgent'

import { loadAgentBodies } from './catalogClient'
import { AGENT_FILE } from './catalogTypes'
import type { AgentIndexEntry, CatalogIndex, TeamIndexEntry } from './catalogTypes'

// ─── Lookups ────────────────────────────────────────────────────────────────

/** Case-insensitive match over name, description, and tags. */
function matches(entry: { name: string; description: string; tags: string[] }, q: string): boolean {
  return (
    entry.name.toLowerCase().includes(q) ||
    entry.description.toLowerCase().includes(q) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(q))
  )
}

export function searchTeamCatalog(index: CatalogIndex, query: string): TeamIndexEntry[] {
  const q = query.toLowerCase().trim()
  if (!q) return index.teams
  return index.teams.filter((t) => matches(t, q))
}

export function searchAgentCatalog(index: CatalogIndex, query: string): AgentIndexEntry[] {
  const q = query.toLowerCase().trim()
  if (!q) return index.agents
  return index.agents.filter((a) => matches(a, q) || a.role.toLowerCase().includes(q))
}

export function getTeamTemplate(index: CatalogIndex, id: string): TeamIndexEntry | undefined {
  return index.teams.find((t) => t.id === id)
}

export function getAgent(index: CatalogIndex, id: string): AgentIndexEntry | undefined {
  return index.agents.find((a) => a.id === id)
}

export function getTemplatesByCategory(
  index: CatalogIndex,
  cat: TemplateCategory,
): TeamIndexEntry[] {
  return index.teams.filter((t) => t.category === cat)
}

/** Teams belonging to one pack. `packId` rather than `source`: the pack is what the filter chip names. */
export function getTemplatesBySource(
  index: CatalogIndex,
  packId: TemplateSource,
): TeamIndexEntry[] {
  return index.teams.filter((t) => t.packId === packId)
}

/**
 * How many teams each agent appears in, as one pass over the index.
 *
 * `AgentCard` renders this per card. Computed naively inside the component it is
 * O(agents x teams) per render, so callers build this map once per index load
 * and read it by id.
 */
export function buildTeamCountByAgent(index: CatalogIndex): Map<string, number> {
  const counts = new Map<string, number>()
  for (const team of index.teams) {
    for (const id of team.agentIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/** Teams whose roster includes the given agent id. */
export function teamsContainingAgent(index: CatalogIndex, agentId: string): TeamIndexEntry[] {
  return index.teams.filter((t) => t.agentIds.includes(agentId))
}

/** Index agents whose `skillIds` include the given skill id. */
export function getAgentsForSkill(index: CatalogIndex, skillId: string): AgentIndexEntry[] {
  return index.agents.filter((a) => a.skillIds.includes(skillId))
}

// ─── Resolve team agents ────────────────────────────────────────────────────

/**
 * Flat structural shape used by deploy loops and UI previews. A subset of
 * `AgentCatalogEntry ∪ AgentTemplate` — fields every consumer needs.
 */
export interface ResolvedAgent {
  id: string
  name: string
  role: string
  emoji?: string
  color?: string
  /**
   * The agent's documents, keyed by filename — `AgentBody.files`, with the
   * team's per-member AGENTS.md routing already overlaid where the team has one.
   *
   * Consumers read `files[AGENT_FILE.soul]` and friends. The deploy path then
   * rewrites IDENTITY.md with the final agent name and SYNTHESIZES AGENTS.md and
   * CLAWBOO.md from the team topology, so this map is an input to that step, not
   * the payload itself.
   */
  files: Record<string, string>
}

/** The card-renderable half of a resolved agent. No body, so no fetch. */
export type RosterAgent = Pick<ResolvedAgent, 'id' | 'name' | 'role' | 'emoji' | 'color'>

/** The three files a legacy inline `AgentTemplate` carries, as a files map. */
function filesFrom(a: AgentTemplate): Record<string, string> {
  const files: Record<string, string> = {
    [AGENT_FILE.soul]: a.soulTemplate,
    [AGENT_FILE.identity]: a.identityTemplate,
    [AGENT_FILE.tools]: a.toolsTemplate,
  }
  if (a.agentsTemplate !== undefined) files[AGENT_FILE.agents] = a.agentsTemplate
  return files
}

function slugify(str: string): string {
  return (
    str
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  )
}

/** True when `profile` carries its own inline agent bodies (legacy shapes). */
function inlineAgents(profile: ProfileLike): ResolvedAgent[] | null {
  // Legacy TeamTemplate with inline agents[] (user-defined, not in the catalog)
  if (
    'source' in profile &&
    'category' in profile &&
    'agents' in profile &&
    profile.agents &&
    profile.agents.length > 0 &&
    'toolsTemplate' in profile.agents[0]
  ) {
    const t = profile as TeamTemplate
    return (t.agents ?? []).map((a) => ({
      id: slugify(a.name),
      name: a.name,
      role: a.role,
      files: filesFrom(a),
    }))
  }

  // Legacy TeamProfile (AgentProfile[] + shared skills[])
  if (!('agentIds' in profile) || !profile.agentIds?.length) {
    const tp = profile as TeamProfile
    if (tp.agents?.length) {
      const toolsMd = buildToolsMd(tp.skills ?? [])
      return tp.agents.map((a) => ({
        id: slugify(a.name),
        name: a.name,
        role: a.name,
        files: {
          [AGENT_FILE.soul]: a.soulTemplate,
          [AGENT_FILE.identity]: a.identityTemplate,
          [AGENT_FILE.tools]: toolsMd,
        },
      }))
    }
  }

  return null
}

/**
 * The card-renderable roster. Synchronous, index only.
 *
 * A dangling `agentId` is skipped, matching the previous behaviour: the emitted
 * index is checked for referential integrity by `catalogDist.test.ts`, so a gap
 * here means the index is stale rather than the team being wrong.
 */
export function resolveTeamRoster(index: CatalogIndex, profile: ProfileLike): RosterAgent[] {
  if ('agentIds' in profile && profile.agentIds?.length) {
    const out: RosterAgent[] = []
    for (const id of profile.agentIds) {
      const a = index.agents.find((e) => e.id === id)
      if (!a) continue
      out.push({ id: a.id, name: a.name, role: a.role, emoji: a.emoji, color: a.color })
    }
    return out
  }
  return (inlineAgents(profile) ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    emoji: a.emoji,
    color: a.color,
  }))
}

/**
 * The full resolution, including markdown bodies. Fetches one body per member.
 *
 * `routing` lives in the TEAM body, so a caller that needs per-member AGENTS.md
 * overrides passes them in. Deploy reads them from the team body it already
 * fetched; the preview surfaces do not need them.
 */
export async function resolveTeamAgents(
  index: CatalogIndex,
  profile: ProfileLike,
  routing?: Record<string, string>,
): Promise<ResolvedAgent[]> {
  const inline = inlineAgents(profile)
  if (inline) return inline

  const roster = resolveTeamRoster(index, profile)
  const bodies = await loadAgentBodies(roster.map((r) => r.id))
  return roster.map((r, i) => {
    const body = bodies[i]
    // The team's routing overrides the entry's own AGENTS.md. Overlaid here so
    // every consumer sees one merged map instead of remembering the precedence.
    const override = routing?.[r.id]
    const files =
      override === undefined ? body.files : { ...body.files, [AGENT_FILE.agents]: override }
    return { id: r.id, name: r.name, role: r.role, emoji: r.emoji, color: r.color, files }
  })
}

// ─── Display metadata ───────────────────────────────────────────────────────
//
// `TEMPLATE_CATEGORIES` and `SOURCE_META` used to live here as exhaustive maps
// over the (then closed) category and source unions. Both unions are open now,
// so an exhaustive map is not expressible and an unguarded index on one is a
// white screen. `metaFor` / `sourceMetaFor` in `./registry` replace them, and
// the option lists are DERIVED from what the loaded index actually contains
// rather than declared ahead of it.
