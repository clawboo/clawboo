// Tool-output compaction types. Pure + browser-safe; runs between an adapter's
// `tool-result` and context insertion to cut verbose output before it's
// re-injected — without ever losing an error.

/** What one compaction pass did (auditable — a user can spot a bad rule). */
export interface CompactionStats {
  /** The rule that fired, or a `passthrough-*` reason when nothing was applied. */
  rule: string
  originalBytes: number
  compactedBytes: number
  /** True only when the output was actually changed (and kept). */
  applied: boolean
}

export interface CompactionResult {
  text: string
  stats: CompactionStats
}

/** A content-sniffing compaction rule: matches by tool name + output shape. */
export interface CompactionRule {
  /** Rule id (surfaces in `stats.rule`). */
  id: string
  /** True if this rule should handle the given tool output. */
  matches(toolName: string, output: string): boolean
  /** Transform raw output → compacted text. */
  compact(output: string): string
}

export interface CompactOptions {
  /**
   * Overlay rules, highest precedence first (project → user). They are tried
   * BEFORE the builtins, so a project rule can pre-empt a builtin for a tool.
   */
  rules?: CompactionRule[]
  /** Skip compaction below this many input bytes (default 512). */
  minBytes?: number
  /** Keep the compaction only if it saves at least this fraction (default 0.05). */
  minSavings?: number
}
