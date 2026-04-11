// AUTO-GENERATED — do not edit manually.
// Regenerate: pnpm ingest:marketplace

import type { AgentCatalogEntry, AgentDomain, TemplateSource } from '@/features/teams/types'
import { AGENCY_AGENTS } from './agency'
import { AWESOME_OPENCLAW_AGENTS } from './awesome-openclaw'
import { CLAWBOO_AGENTS } from './clawboo'

export { AGENCY_AGENTS } from './agency'
export { AWESOME_OPENCLAW_AGENTS } from './awesome-openclaw'
export { CLAWBOO_AGENTS } from './clawboo'

/** All agents in the catalog — agency-agents + awesome-openclaw + clawboo builtins. */
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  ...AGENCY_AGENTS,
  ...AWESOME_OPENCLAW_AGENTS,
  ...CLAWBOO_AGENTS,
]

/** Look up an agent by ID. */
export function getAgent(id: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find((a) => a.id === id)
}

/** Get all agents for a given domain. */
export function getAgentsByDomain(domain: AgentDomain): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter((a) => a.domain === domain)
}

/** Get all agents from a given source. */
export function getAgentsBySource(source: TemplateSource): AgentCatalogEntry[] {
  return AGENT_CATALOG.filter((a) => a.source === source)
}

/**
 * Search agents by query — matches name, role, description, tags (case-insensitive).
 */
export function searchAgentCatalog(query: string): AgentCatalogEntry[] {
  if (!query.trim()) return AGENT_CATALOG
  const q = query.toLowerCase()
  return AGENT_CATALOG.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      a.role.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.tags.some((t) => t.includes(q)),
  )
}
