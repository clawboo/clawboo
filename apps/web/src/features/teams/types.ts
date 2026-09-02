// ─── Template types (v2 — team marketplace) ──────────────────────────────────

import type { CategoryId, SourceId } from '@clawboo/pack-format'

import type { SelectableSourceId } from './runtimeSelection'

/**
 * BOTH OF THESE ARE OPEN UNIONS, re-exported from the pack format so the app and
 * the schema cannot drift.
 *
 * The known values still autocomplete; any other string is legal, because a
 * third-party pack must be able to bring a pack id and a category without a
 * Clawboo release. The cost is that `Record<TemplateSource, …>` and
 * `Record<TemplateCategory, …>` no longer typecheck as exhaustive maps — which
 * is the point: display metadata resolves through `metaFor` / `sourceMetaFor`
 * in `features/marketplace/registry.ts`, which are total by construction. An
 * unguarded index on a map keyed by one of these is what used to white-screen
 * the Agents tab on an unknown value.
 */
export type TemplateSource = SourceId
export type TemplateCategory = CategoryId

/** First-class standalone agent entry in the agent catalog. */
export interface AgentCatalogEntry {
  /** Globally unique identifier, e.g. 'agency-frontend-developer' */
  id: string
  /**
   * The pack that owns this entry. Equal to `source` for now; the two separate
   * when one pack carries entries drawn from several upstreams.
   */
  packId: TemplateSource
  /** Display name shown on cards, e.g. 'Frontend Developer Boo' */
  name: string
  /** Short role label, e.g. 'Frontend Developer' */
  role: string
  emoji: string
  /** Hex accent color */
  color: string
  /** 1–2 sentence card description */
  description: string
  /** Upstream provenance label. */
  source: TemplateSource
  /** GitHub blob URL for MIT attribution */
  sourceUrl: string
  category: TemplateCategory
  tags: string[]
  /** Skill IDs from BUILTIN_SKILLS that this agent uses */
  skillIds: string[]

  /**
   * Distilled 20–40 line mission statement (written to SOUL.md on deploy).
   * Extracted from ## Core Mission, ## Critical Rules, ## Communication Style sections.
   */
  soulTemplate: string
  /**
   * The agent's complete instruction body, written to IDENTITY.md on deploy.
   * Adapted from the upstream file, not a verbatim copy: the YAML frontmatter is
   * stripped (the catalog stores those fields structurally) and the prose is
   * edited. It must still be the whole body, never a summary or an excerpt.
   */
  identityTemplate: string
  /** TOOLS.md content built from skillIds (e.g. '# TOOLS\n\n## Skills\n- web-search') */
  toolsTemplate: string
  /** Optional AGENTS.md content when agent appears in a team with routing */
  agentsTemplate?: string
  /**
   * Optional per-agent "chef's suggestion" runtime for CreateTeamModal's picker.
   * Unpopulated today (the deploy resolver falls back to the team default / source
   * rule); a future catalog can set it to steer a specific agent's default runtime.
   */
  suggestedRuntime?: SelectableSourceId
}

export interface AgentTemplate {
  name: string
  role: string
  soulTemplate: string
  identityTemplate: string
  toolsTemplate: string
  agentsTemplate?: string
}

export interface TeamTemplate {
  id: string
  /** The pack that owns this entry. Equal to `source` for now. */
  packId: TemplateSource
  name: string
  emoji: string
  color: string
  description: string
  category: TemplateCategory
  source: TemplateSource
  sourceUrl?: string
  tags: string[]
  /**
   * @deprecated Use `agentIds` referencing AGENT_CATALOG entries instead.
   * Kept for backward compatibility so hypothetical user-defined templates with
   * inline agents still typecheck. All first-party teams now use `agentIds`.
   */
  agents?: AgentTemplate[]
  /**
   * Agent IDs from AGENT_CATALOG. Replaces inline `agents` array.
   * When present, consumers should resolve via `resolveTeamAgents(team)`.
   */
  agentIds?: string[]
  /** Per-agent AGENTS.md routing content for this team, keyed by agentId */
  routing?: Record<string, string>
  /** Full workflow prose for the team, rendered on the team detail sheet */
  workflowNarrative?: string
  /**
   * Optional team-wide "chef's suggestion" default runtime for CreateTeamModal's
   * picker. Unpopulated today — the deploy resolver falls back to the SOURCE RULE (a
   * browsable marketplace team → OpenClaw). A future team can set it (e.g. a native
   * default) by editing the team entry directly.
   */
  defaultRuntime?: SelectableSourceId
}

/** Union of new TeamTemplate and legacy TeamProfile — used by CreateTeamModal and MarketplacePanel. */
export type ProfileLike = TeamTemplate | TeamProfile

// ─── Team profile types (legacy) ──────────────────────────────────────────────

/** @deprecated Use AgentTemplate instead. */
export interface AgentProfile {
  /** Display name — used as the agent's name on creation */
  name: string
  /** Raw content for the agent's SOUL.md file */
  soulTemplate: string
  /** Raw content for the agent's IDENTITY.md file */
  identityTemplate: string
}

/** @deprecated Use TeamTemplate instead. */
export interface TeamProfile {
  /** Unique identifier used for routing and keys */
  id: string
  /** Display name shown in the picker card */
  name: string
  /** Single emoji representing the team */
  emoji: string
  /** Accent color for the card (hex) */
  color: string
  /** One-sentence description shown on the card */
  description: string
  /** Ordered list of agents to create on deploy */
  agents: AgentProfile[]
  /** Skill identifiers to install in each agent's TOOLS.md */
  skills: string[]
  /** Preferred graph layout positions, indexed by agents array order */
  graphLayout: {
    positions: Array<{ x: number; y: number }>
  }
}
