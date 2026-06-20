// Prompt-tier types for KV-/prompt-cache discipline. Generic + browser-safe —
// the seam every runtime adapter assembles its prompt through so the stable
// content forms a cacheable prefix and only the volatile tail changes per turn.

/** A tool definition with at least a name (the cache-stable sort key). */
export interface ToolDef {
  name: string
  [k: string]: unknown
}

/**
 * The three prompt tiers, ordered by how often they change:
 * - `stable`   — frozen for the session: identity, tool guidance, skills index.
 *                The cache anchor; rebuild only on compaction.
 * - `context`  — changes infrequently: caller/system message, team manifest,
 *                project files.
 * - `volatile` — per-turn: memory snapshot, last handoff summary, a DATE-ONLY
 *                timestamp (never minute/second precision — that busts the cache).
 */
export interface PromptTiers {
  stable: string
  context: string
  volatile: string
}

/** A suggested cache breakpoint: a byte offset into the assembled prompt. */
export interface CacheBreakpoint {
  /** Byte offset (UTF-8) into `prompt` where a cache_control marker is suggested. */
  offset: number
  /** What the breakpoint anchors (debugging / consumer mapping). */
  label: 'stable' | 'context'
}

export interface AssembledPrompt {
  /** stable → context → volatile, joined. */
  prompt: string
  /** The cacheable head (stable + context); identical turn-over-turn. */
  stablePrefix: string
  /** Byte length (UTF-8) of `stablePrefix` — the unit providers cache on. */
  stablePrefixBytes: number
  /**
   * Suggested cache_control breakpoints for an Anthropic-style consumer. OpenAI
   * ignores these (automatic prefix caching); OpenClaw ignores them (the Gateway
   * owns caching). The seam future spawn-our-own adapters map to message blocks.
   */
  cacheBreakpoints: CacheBreakpoint[]
}
