// ─── Team profile types ───────────────────────────────────────────────────────

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
