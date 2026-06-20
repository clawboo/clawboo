import { z } from 'zod'

/**
 * The normalized native-agent shape — what a `clawboo-native` agent IS, beyond
 * its registry row: identity prompt, provider routing, tool-surface toggles,
 * participation, and caps. Persisted by the host as JSON (settings KV keyed by
 * agent id); validated through `agentConfigSchema` on every load so a corrupt
 * blob degrades to the default config instead of crashing a run.
 *
 * Native agents coexist with every other runtime's agents as peers — there is
 * deliberately NO conversion/export mapping to any other runtime's agent-file
 * format here.
 */

/** Known first-party providers. Open set — a custom OpenAI-compatible provider
 *  id is allowed (it rides the openai client with a base-URL override). */
export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'ollama'] as const
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number]

const fallbackSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
})

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The stable prompt tier — KV-cache safe (the harness never injects
   *  volatile content into it). */
  systemPrompt: z.string(),
  // ── Routing ──────────────────────────────────────────────────────────
  primaryProvider: z.string().min(1),
  primaryModel: z.string().min(1),
  fallbacks: z.array(fallbackSchema).optional(),
  /** Vault env-var NAME for the primary provider's key (never the secret). */
  envVar: z.string().min(1),
  // ── Tool surface (the shared MCP spine + the runtime's private plane) ─
  tools: z.object({
    /** Memory MCP (shared facts). */
    memory: z.boolean(),
    /** Tools MCP / managed capability broker. */
    tools: z.boolean(),
    /** Tasks MCP / the durable board. */
    tasks: z.boolean(),
    /** TeamChat MCP — post + listen in the shared team room as a named peer. */
    teamchat: z.boolean(),
    /** Additional MCP service refs (reserved). */
    custom: z.array(z.string()).optional(),
  }),
  // ── Participation + caps ─────────────────────────────────────────────
  /** Open set — 'agent' today; a human participant slots in without code
   *  branching on this value. */
  participantKind: z.string().min(1),
  maxTurns: z.number().int().positive().optional(),
  /** null = system default (track-and-warn). A set value creates an
   *  agent-scope hard-cap budget at create time. */
  budgetUsd: z.number().positive().nullable().optional(),
  // ── Persistence ──────────────────────────────────────────────────────
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Dormant multi-tenant seam — always null today. */
  tenantId: z.string().nullable(),
})

export type AgentConfig = z.infer<typeof agentConfigSchema>

export const DEFAULT_MAX_TURNS = 16

/** The config a run falls back to when the agent id has no stored config
 *  (e.g. a board task assigned to an arbitrary id). Anthropic + all shared
 *  tools on; the key still resolves through the host's vault chain. */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  id: 'native-default',
  name: 'Native Agent',
  systemPrompt:
    'You are a capable, concise agent on a small team. Work the task you are ' +
    'given using the available tools, then reply with a short summary of what ' +
    'you did and any follow-ups.',
  primaryProvider: 'anthropic',
  primaryModel: 'claude-haiku-4-5',
  envVar: 'ANTHROPIC_API_KEY',
  tools: { memory: true, tools: true, tasks: true, teamchat: true },
  participantKind: 'agent',
  maxTurns: DEFAULT_MAX_TURNS,
  budgetUsd: null,
  createdAt: 0,
  updatedAt: 0,
  tenantId: null,
}

/** Parse a stored JSON blob; null (and a logged-by-caller fallback to the
 *  default) on corrupt/invalid content — a bad blob must never crash a run. */
export function parseAgentConfig(json: string | null): AgentConfig | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    const result = agentConfigSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** Conventional vault env-var per known provider (ollama is keyless). */
export function envVarForProvider(provider: string): string | null {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY'
    case 'openai':
      return 'OPENAI_API_KEY'
    case 'openrouter':
      return 'OPENROUTER_API_KEY'
    case 'ollama':
      return null
    default:
      return null
  }
}
