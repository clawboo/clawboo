// The v1 marketplace pack shape.
//
// TWO UNIONS ARE OPEN AND ONE IS CLOSED, and the difference is the whole point
// of this file.
//
// `SourceId` and `CategoryId` are OPEN: a third-party pack must be able to
// introduce a pack id and a category without a Clawboo release. The known values
// still autocomplete, and every consumer resolves display metadata through a
// total function (`metaFor` / `sourceMetaFor` in the app) rather than by
// indexing a `Record<Union, …>` that an unknown value would miss.
//
// `SkillCategory` is CLOSED, deliberately. It is shared with the Ghost Graph
// capability model (`apps/web/src/features/graph/types.ts`); opening it would
// leak a marketplace concern into the graph model for no gain.

import type { CURRENT_SCHEMA_VERSION } from './version'

/**
 * Open union: the listed values autocomplete, any other string is still legal.
 *
 * The `& {}` half is the idiom that keeps the literal suggestions alive. Without
 * it TypeScript collapses `'a' | 'b' | string` to plain `string` and the editor
 * offers nothing.
 */
export type Open<K extends string> = K | (string & {})

/** The pack that owns an entry. Open: a third-party pack brings its own id. */
export type SourceId = Open<'clawboo' | 'agency-agents'>

/** Browse taxonomy. Open, with 19 known values. */
export type CategoryId = Open<
  | 'academic'
  | 'content'
  | 'design'
  | 'devops'
  | 'education'
  | 'engineering'
  | 'game-dev'
  | 'general'
  | 'marketing'
  | 'ops'
  | 'paid-media'
  | 'product'
  | 'project-management'
  | 'research'
  | 'sales'
  | 'spatial'
  | 'specialized'
  | 'support'
  | 'testing'
>

/**
 * CLOSED, deliberately. Shared with the Ghost Graph capability model
 * (`features/graph/types.ts`). Opening it leaks a marketplace concern into the
 * graph model for no gain.
 */
export type SkillCategory = 'code' | 'web' | 'data' | 'comm' | 'file' | 'other'

/** SPDX licence identifier. Open, because SPDX is a long list. */
export type SpdxId = Open<'MIT' | 'Apache-2.0' | 'BSD-3-Clause' | 'CC-BY-4.0' | 'CC0-1.0'>

/** How much of the upstream text survived into the pack. */
export type Adaptation = 'verbatim' | 'adapted' | 'original'

/**
 * Per-entry attribution, for a pack whose entries do not all share one upstream.
 * Omitted entries inherit the pack's `provenance`.
 */
export interface EntryOrigin {
  /** Canonical URL for the upstream file this entry came from. */
  url?: string
  /** Overrides the pack-level `provenance.adaptation` for this one entry. */
  adaptation?: Adaptation
  /** Overrides the pack-level `provenance.authors` for this one entry. */
  authors?: string[]
}

/** Lives ONCE per pack. Replaces a per-entry `source` + `sourceUrl` pair. */
export interface Provenance {
  sourceId: SourceId
  label: string
  /** MUST be #RRGGBB. The cards concatenate alpha suffixes onto it. */
  color: string
  repo?: string
  /** Commit sha or tag the import was taken at. */
  ref?: string
  license: SpdxId
  authors?: string[]
  adaptation: Adaptation
  /** ISO-8601 instant. */
  importedAt: string
}

export interface PackManifest {
  /**
   * FIRST key, integer, the dispatch key for the version ladder. A parsed pack
   * is always at `CURRENT_SCHEMA_VERSION`: the parser upgrades a declared older
   * version before it hands the document back.
   */
  schemaVersion: typeof CURRENT_SCHEMA_VERSION
  id: SourceId
  /** Entry-id prefix. Defaults to `id`. Keeps 'agency-agents' emitting 'agency-'. */
  idPrefix?: string
  name: string
  description: string
  /** semver of the CONTENT. Range-looking strings ('^1.2.3', '1.x') are rejected. */
  version: string
  provenance: Provenance
  counts: { agents: number; teams: number; skills: number }
  /** Reviewable line in the content PR when a pack introduces a taxonomy value. */
  newCategories?: string[]
  /** Former id -> current id, or null if removed. NOT schema migration. */
  renames?: Record<string, string | null>
}

export interface AgentListing {
  /** `${idPrefix ?? id}-${slug}`, globally unique, flat kebab-case. */
  id: string
  packId: SourceId
  slug: string
  name: string
  role: string
  emoji: string
  /** #RRGGBB. */
  color: string
  description: string
  category: CategoryId
  tags: string[]
  skillIds: string[]
  /** Relative path to this entry's AgentBody document. */
  body: string
  origin?: EntryOrigin
  suggestedRuntime?: string
}

/** Denormalised so cards render count + roles with no body fetch. */
export interface TeamMemberRef {
  agentId: string
  name: string
  role: string
}

export interface TeamListing {
  id: string
  packId: SourceId
  slug: string
  name: string
  emoji: string
  /** #RRGGBB. */
  color: string
  description: string
  category: CategoryId
  tags: string[]
  members: TeamMemberRef[]
  /** Relative path to this entry's TeamBody document. */
  body: string
  origin?: EntryOrigin
  defaultRuntime?: string
}

export interface PackSkill {
  id: string
  name: string
  description: string
  category: SkillCategory
  tags: string[]
}

export interface AgentBody {
  id: string
  /**
   * SOUL.md and IDENTITY.md are required (enforced by a schema refine).
   *
   * A map, not named fields: adding a fifth agent file becomes a no-op here
   * instead of a shape change every reader has to follow.
   *
   * This is the SOURCE for SOUL.md / IDENTITY.md / TOOLS.md only. AGENTS.md and
   * CLAWBOO.md are synthesized per-deploy from the team topology and never exist
   * in a pack, and IDENTITY.md is rewritten with the final agent name, so the
   * deploy path overlays on top of this map rather than passing it through.
   */
  files: Record<string, string>
}

export interface TeamBody {
  id: string
  workflowNarrative?: string
  /** Per-member AGENTS.md routing content, keyed by agent id. */
  routing?: Record<string, string>
}

/** A whole pack document: the manifest plus its three entry lists. */
export interface AgentPack extends PackManifest {
  agents: AgentListing[]
  teams: TeamListing[]
  skills: PackSkill[]
}
