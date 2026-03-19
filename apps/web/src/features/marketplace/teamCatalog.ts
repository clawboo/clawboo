import type { TeamTemplate, TemplateCategory, TemplateSource } from '@/features/teams/types'

import { ALL_TEMPLATES } from './templates'

// ─── Catalog ────────────────────────────────────────────────────────────────

export const TEAM_CATALOG: TeamTemplate[] = ALL_TEMPLATES

/** Builtin templates shipped with Clawboo — used by OnboardingWizard. */
export const STARTER_TEMPLATES: TeamTemplate[] = TEAM_CATALOG.filter((t) => t.source === 'clawboo')

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
