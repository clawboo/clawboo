// Shapes of the marketplace catalog AS THE BROWSER RECEIVES IT.
//
// The wire shape, in other words: what `/api/catalog/*` answers with. The
// authoritative pack shape lives in `@clawboo/pack-format`; the server flattens
// a verified pack down to these entries, so the browser never has to know that
// packs exist. `scripts/catalog/build-index.ts` produces the same rows for the
// committed index, and `catalogDist.test.ts` asserts the two agree.
//
// The split rule: an index row carries what a CARD renders, a body carries what
// a DETAIL SHEET or a DEPLOY needs. `identityTemplate` and `soulTemplate` alone
// are 82.5% of the catalog's bytes and no card reads either.

import type { AgentCatalogEntry, TeamTemplate } from '@/features/teams/types'

/** Bumped only when the shape changes in a way a stale client cannot read. */
export const CATALOG_SCHEMA_VERSION = 1

export interface AgentIndexEntry {
  id: string
  /** The pack that owns the entry. What the badge and the pack filter read. */
  packId: AgentCatalogEntry['packId']
  name: string
  role: string
  emoji: string
  color: string
  description: string
  /** Upstream provenance label. Equal to `packId` today. */
  source: AgentCatalogEntry['source']
  category: AgentCatalogEntry['category']
  tags: string[]
  skillIds: string[]
  suggestedRuntime?: AgentCatalogEntry['suggestedRuntime']
}

export interface TeamIndexEntry {
  id: string
  packId: TeamTemplate['packId']
  name: string
  emoji: string
  color: string
  description: string
  category: TeamTemplate['category']
  source: TeamTemplate['source']
  tags: string[]
  agentIds: string[]
  defaultRuntime?: TeamTemplate['defaultRuntime']
}

/** One installed pack, as the server reports it on the merged index. */
/**
 * Where a pack's content came from. Most of this catalog is other people's work,
 * adapted under a permissive licence, and the UI is expected to say so: the
 * author, the commit and the licence are what let a user judge what they are
 * about to deploy. `adaptation` separates content written for Clawboo from
 * content adapted from an upstream project.
 */
export interface CatalogProvenance {
  label: string
  license: string
  /** Upstream repo URL. Absent for first-party packs written here. */
  repo?: string
  /** The 40-hex commit the import was pinned to. Absent with no upstream. */
  ref?: string
  authors?: string[]
  adaptation: 'adapted' | 'original' | (string & {})
}

export interface CatalogPackRef {
  publisher: string
  slug: string
  id: string
  version: string
  /** Author, licence and pinned commit. Surfaced on cards and detail sheets. */
  provenance?: CatalogProvenance
  /**
   * True for the pack that is compiled into this build rather than fetched.
   * The seed is always present, so the browse surfaces are never empty even
   * with no network at all.
   */
  offline?: boolean
}

export interface CatalogIndex {
  schemaVersion: number
  counts: { agents: number; teams: number }
  agents: AgentIndexEntry[]
  teams: TeamIndexEntry[]
  /**
   * Which packs the rows came from. Informational for the browser; the SERVER
   * is what verifies pack integrity before a row is ever served.
   */
  packs?: CatalogPackRef[]
}

/**
 * Fields that must never reach an index row. Named once so the guard test
 * asserts against this list rather than re-typing it and drifting.
 *
 * Both spellings are listed on purpose. The four `*Template` names are the
 * SOURCE spelling the catalog used before it became JSON packs, and `files` /
 * `routing` / `workflowNarrative` are the pack spelling. Either name appearing
 * on an index row is the same regression: the browse payload has grown a body.
 */
export const BODY_FIELDS = [
  'soulTemplate',
  'identityTemplate',
  'toolsTemplate',
  'agentsTemplate',
  'files',
  'workflowNarrative',
  'routing',
  'sourceUrl',
] as const

export interface AgentBody {
  id: string
  /**
   * The agent's documents, keyed by filename: SOUL.md and IDENTITY.md always,
   * TOOLS.md always, AGENTS.md when the entry carries its own routing.
   *
   * A MAP, NOT NAMED FIELDS. Adding a fifth agent file becomes a no-op here
   * instead of a shape change every reader has to follow.
   *
   * This is the source for those three files only. The deploy path OVERLAYS on
   * top of it: AGENTS.md and CLAWBOO.md are synthesized per-deploy from the team
   * topology (`lib/teamProtocol.ts`) and never exist in the catalog, and
   * IDENTITY.md is rewritten with the agent's final, deduped name. Passing this
   * map straight through would silently drop the team protocol docs the whole
   * orchestration contract depends on.
   */
  files: Record<string, string>
  /** Attribution link. Read only by the detail sheet, which already fetches this. */
  sourceUrl: string
}

/** Filenames the projection writes into `AgentBody.files`. */
export const AGENT_FILE = {
  soul: 'SOUL.md',
  identity: 'IDENTITY.md',
  tools: 'TOOLS.md',
  agents: 'AGENTS.md',
} as const

export interface TeamBody {
  id: string
  workflowNarrative?: string
  routing?: Record<string, string>
  sourceUrl?: string
}
