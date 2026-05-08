import type {
  AgentCatalogEntry,
  ProfileLike,
  TeamProfile,
  TeamTemplate,
  TemplateCategory,
  TemplateSource,
} from '@/features/teams/types'
import { buildToolsMd } from '@/lib/createAgent'

import { AGENT_CATALOG, getAgent as getAgentFromCatalog } from './agents'
import { TEAM_CATALOG as RAW_TEAM_CATALOG } from './teams'

// ─── Catalog ────────────────────────────────────────────────────────────────

export const TEAM_CATALOG: TeamTemplate[] = RAW_TEAM_CATALOG

/** Builtin templates shipped with Clawboo — used by OnboardingWizard. */
export const STARTER_TEMPLATES: TeamTemplate[] = TEAM_CATALOG.filter((t) => t.source === 'clawboo')

// ─── Browsable catalog (sorted: agency-agents > awesome-openclaw > clawboo) ─

const SOURCE_PRIORITY: Record<TemplateSource, number> = {
  'agency-agents': 0,
  'awesome-openclaw': 1,
  clawboo: 2,
}

/** All templates sorted by source priority — agency-agents first, clawboo last. */
export const BROWSABLE_TEAM_CATALOG: TeamTemplate[] = [...TEAM_CATALOG].sort(
  (a, b) => (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9),
)

/** Search the sorted browsable catalog by name, description, or tags. */
export function searchBrowsableCatalog(query: string): TeamTemplate[] {
  const q = query.toLowerCase().trim()
  if (!q) return BROWSABLE_TEAM_CATALOG
  return BROWSABLE_TEAM_CATALOG.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q)),
  )
}

// ─── Lookups ────────────────────────────────────────────────────────────────

export function searchTeamCatalog(query: string): TeamTemplate[] {
  const q = query.toLowerCase().trim()
  if (!q) return TEAM_CATALOG
  return TEAM_CATALOG.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q)),
  )
}

export function getTeamTemplate(id: string): TeamTemplate | undefined {
  return TEAM_CATALOG.find((t) => t.id === id)
}

export function getTemplatesByCategory(cat: TemplateCategory): TeamTemplate[] {
  return TEAM_CATALOG.filter((t) => t.category === cat)
}

export function getTemplatesBySource(source: TemplateSource): TeamTemplate[] {
  return TEAM_CATALOG.filter((t) => t.source === source)
}

// ─── Agent catalog passthrough helpers ──────────────────────────────────────

export { AGENT_CATALOG }

/** Look up a catalog agent by ID. Re-exported from `./agents` for convenience. */
export function getAgent(id: string): AgentCatalogEntry | undefined {
  return getAgentFromCatalog(id)
}

/** Return teams that include the given agent ID (via `agentIds`). */
export function teamsContainingAgent(agentId: string): TeamTemplate[] {
  return TEAM_CATALOG.filter((t) => t.agentIds?.includes(agentId))
}

/** Return catalog agents whose `skillIds` include the given skill ID. */
export function getAgentsForSkill(skillId: string): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter((a) => a.skillIds.includes(skillId))
}

// ─── Resolve team agents (the key migration helper) ────────────────────────

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
  soulTemplate: string
  identityTemplate: string
  toolsTemplate: string
  agentsTemplate?: string
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

/**
 * Resolve a `ProfileLike` into a concrete list of agents for deploy/preview.
 * Handles three input shapes:
 *   - New `TeamTemplate` with `agentIds` → resolved via AGENT_CATALOG.
 *   - Legacy `TeamTemplate` with inline `agents` (user-defined templates).
 *   - Legacy `TeamProfile` with `agents[]` + shared `skills[]`.
 */
export function resolveTeamAgents(profile: ProfileLike): ResolvedAgent[] {
  // Path A: new TeamTemplate with agentIds[]
  if ('agentIds' in profile && profile.agentIds && profile.agentIds.length > 0) {
    const out: ResolvedAgent[] = []
    for (const id of profile.agentIds) {
      const a = getAgentFromCatalog(id)
      if (!a) continue // dangling id — teamCoverage.test.ts catches this
      const routedAgentsTemplate = (profile as TeamTemplate).routing?.[a.id] ?? a.agentsTemplate
      out.push({
        id: a.id,
        name: a.name,
        role: a.role,
        emoji: a.emoji,
        color: a.color,
        soulTemplate: a.soulTemplate,
        identityTemplate: a.identityTemplate,
        toolsTemplate: a.toolsTemplate,
        agentsTemplate: routedAgentsTemplate,
      })
    }
    return out
  }

  // Path B: legacy TeamTemplate with inline agents[] (user-defined, not in catalog)
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
      soulTemplate: a.soulTemplate,
      identityTemplate: a.identityTemplate,
      toolsTemplate: a.toolsTemplate,
      agentsTemplate: a.agentsTemplate,
    }))
  }

  // Path C: legacy TeamProfile (AgentProfile[] + shared skills[])
  const tp = profile as TeamProfile
  const toolsMd = buildToolsMd(tp.skills ?? [])
  return (tp.agents ?? []).map((a) => ({
    id: slugify(a.name),
    name: a.name,
    role: a.name,
    soulTemplate: a.soulTemplate,
    identityTemplate: a.identityTemplate,
    toolsTemplate: toolsMd,
  }))
}

// ─── Display metadata ───────────────────────────────────────────────────────

export const TEMPLATE_CATEGORIES: { key: TemplateCategory; label: string; color: string }[] = [
  { key: 'engineering', label: 'Engineering', color: '#3B82F6' },
  { key: 'marketing', label: 'Marketing', color: '#EC4899' },
  { key: 'sales', label: 'Sales', color: '#F97316' },
  { key: 'product', label: 'Product', color: '#8B5CF6' },
  { key: 'design', label: 'Design', color: '#F43F5E' },
  { key: 'testing', label: 'Testing', color: '#10B981' },
  { key: 'content', label: 'Content', color: '#6366F1' },
  { key: 'support', label: 'Support', color: '#14B8A6' },
  { key: 'education', label: 'Education', color: '#FBBF24' },
  { key: 'ops', label: 'Operations', color: '#64748B' },
  { key: 'devops', label: 'DevOps', color: '#0EA5E9' },
  { key: 'research', label: 'Research', color: '#A855F7' },
  { key: 'game-dev', label: 'Game Dev', color: '#EF4444' },
  { key: 'spatial', label: 'Spatial', color: '#06B6D4' },
  { key: 'academic', label: 'Academic', color: '#D946EF' },
  { key: 'paid-media', label: 'Paid Media', color: '#F59E0B' },
  { key: 'specialized', label: 'Specialized', color: '#78716C' },
  { key: 'general', label: 'General', color: '#94A3B8' },
]

export const SOURCE_META: Record<TemplateSource, { label: string; color: string }> = {
  clawboo: { label: 'Clawboo', color: '#34D399' },
  'agency-agents': { label: 'Agency Agents', color: '#3B82F6' },
  'awesome-openclaw': { label: 'Awesome OpenClaw', color: '#A855F7' },
}
