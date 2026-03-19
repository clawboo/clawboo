// ─── Template types (v2 — team marketplace) ──────────────────────────────────

export type TemplateSource = 'clawboo' | 'agency-agents' | 'awesome-openclaw'

export type TemplateCategory =
  | 'engineering'
  | 'marketing'
  | 'sales'
  | 'product'
  | 'design'
  | 'testing'
  | 'content'
  | 'support'
  | 'education'
  | 'ops'
  | 'devops'
  | 'research'
  | 'game-dev'
  | 'spatial'
  | 'academic'
  | 'paid-media'
  | 'specialized'
  | 'general'

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
  name: string
  emoji: string
  color: string
  description: string
  category: TemplateCategory
  source: TemplateSource
  sourceUrl?: string
  tags: string[]
  agents: AgentTemplate[]
}

/** Union of new TeamTemplate and legacy TeamProfile — used by CreateTeamModal and MarketplacePanel. */
export type ProfileLike = TeamTemplate | TeamProfile

// ─── Team profile types (legacy — will be deprecated) ─────────────────────────

export interface AgentProfile {
  /** Display name — used as the agent's name on creation */
  name: string
  /** Raw content for the agent's SOUL.md file */
  soulTemplate: string
  /** Raw content for the agent's IDENTITY.md file */
  identityTemplate: string
}

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
