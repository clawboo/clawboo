// The merged catalog plus its two lookups.
//
// Curated entries are hand-written and verified. Community entries (ingested
// from a committed registry snapshot) will land in `./generated/` and merge here
// and are kept in a separate array so the UI can render the hard visual split the
// honesty posture requires, and so the counts are always reportable as
// "N curated · M community" rather than one impressive-looking total.

import { DATA_CONNECTORS } from './sources/data'
import { DEV_CONNECTORS } from './sources/dev'
import { PRODUCTIVITY_CONNECTORS } from './sources/productivity'
import type { ConnectorDefinition } from './types'

/** Hand-written, first-party, each verified against its live package or endpoint. */
export const CURATED_CONNECTORS: readonly ConnectorDefinition[] = Object.freeze([
  ...DEV_CONNECTORS,
  ...DATA_CONNECTORS,
  ...PRODUCTIVITY_CONNECTORS,
])

/**
 * Ingested from the committed registry snapshot. Empty until the ingest script
 * lands: deliberately a real, empty array rather than a TODO, so every consumer
 * is already written against the two-array shape and nothing has to change when
 * it fills.
 */
export const COMMUNITY_CONNECTORS: readonly ConnectorDefinition[] = Object.freeze([])

export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = Object.freeze([
  ...CURATED_CONNECTORS,
  ...COMMUNITY_CONNECTORS,
])

const BY_SLUG: ReadonlyMap<string, ConnectorDefinition> = new Map(
  CONNECTOR_DEFINITIONS.map((c) => [c.slug, c]),
)

/** Exact-slug lookup. Undefined for an unknown slug, never throws. */
export function connectorBySlug(slug: string): ConnectorDefinition | undefined {
  return BY_SLUG.get(slug)
}

export function connectorsByCategory(
  category: ConnectorDefinition['category'],
): ConnectorDefinition[] {
  return CONNECTOR_DEFINITIONS.filter((c) => c.category === category)
}

/**
 * Substring search over the fields a human would actually type: name, slug,
 * description, tags.
 *
 * No minimum query length. A search box that silently returns the unfiltered list
 * below N characters reads as broken rather than as a constraint. If a minimum
 * is ever needed it belongs in the field's placeholder, not in a condition that
 * quietly no-ops.
 */
export function searchConnectors(query: string): ConnectorDefinition[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...CONNECTOR_DEFINITIONS]
  return CONNECTOR_DEFINITIONS.filter((c) => {
    if (c.slug.includes(q)) return true
    if (c.displayName.toLowerCase().includes(q)) return true
    if (c.description.toLowerCase().includes(q)) return true
    return c.tags.some((t) => t.toLowerCase().includes(q))
  })
}

/** `{ curated, community }`: the only counts the UI should ever render. */
export function connectorCounts(): { curated: number; community: number } {
  return { curated: CURATED_CONNECTORS.length, community: COMMUNITY_CONNECTORS.length }
}
