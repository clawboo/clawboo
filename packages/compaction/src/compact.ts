// The compactor entry points. Pass-through-safe (tiny inputs / low-savings →
// original returned untouched) and failure-preserving (an error line in the
// input is guaranteed to survive into the output — else we fall back to the
// original). Auditable: every call returns stats describing what happened.

import { BUILTIN_RULES, FALLBACK_RULE_ID, dedupAndElide, failureLines, shortenUrls } from './rules'
import type { CompactOptions, CompactionResult, CompactionRule, CompactionStats } from './types'

const DEFAULT_MIN_BYTES = 512
const DEFAULT_MIN_SAVINGS = 0.05

/** UTF-8 byte length — browser-safe (TextEncoder is global in Node 22+/browsers). */
function byteLen(s: string): number {
  return new TextEncoder().encode(s).length
}

function passthrough(text: string, rule: string): CompactionResult {
  const n = byteLen(text)
  return { text, stats: { rule, originalBytes: n, compactedBytes: n, applied: false } }
}

/** Every failure line in `original` must survive (as a substring) into `compacted`. */
function preservesFailures(original: string, compacted: string): boolean {
  for (const line of failureLines(original)) {
    const needle = line.trim()
    if (needle && !compacted.includes(needle)) return false
  }
  return true
}

/**
 * Compact one tool's output. Picks the first matching rule (overlay rules →
 * builtins → the `dedup-elide` catch-all), then a safe URL-shortening pass.
 * Returns the original (with `applied:false`) when the input is too small, the
 * savings are below the threshold, or the rule would have dropped an error.
 */
export function compactToolOutput(
  toolName: string,
  output: string,
  opts: CompactOptions = {},
): CompactionResult {
  const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES
  const minSavings = opts.minSavings ?? DEFAULT_MIN_SAVINGS
  const originalBytes = byteLen(output)

  // Pass-through-safe: too small to be worth compacting.
  if (originalBytes < minBytes) return passthrough(output, 'passthrough-small')

  // Overlay rules (project/user) take precedence over the builtins.
  const rules: CompactionRule[] = [...(opts.rules ?? []), ...BUILTIN_RULES]
  const rule = rules.find((r) => r.matches(toolName, output))

  let compacted = rule ? rule.compact(output) : dedupAndElide(output)
  compacted = shortenUrls(compacted) // always-safe final pass
  const ruleId = rule?.id ?? FALLBACK_RULE_ID

  // Failure-preserving: if the rule dropped an error line, return the original.
  if (!preservesFailures(output, compacted)) return passthrough(output, 'failure-preserve-fallback')

  const compactedBytes = byteLen(compacted)
  const savings = (originalBytes - compactedBytes) / originalBytes
  // Pass-through-safe: not enough saved to bother.
  if (savings < minSavings) return passthrough(output, 'passthrough-low-savings')

  return { text: compacted, stats: { rule: ruleId, originalBytes, compactedBytes, applied: true } }
}

// Matches a `[[tool-result]] <name> (<id>)` header through its fenced
// ```text … ``` body (the `formatToolResultMarkdown` shape). Non-greedy so
// each block is captured independently; prose between blocks is untouched.
const TOOL_RESULT_BLOCK =
  /(\[\[tool-result\]\]\s*([^\n(]+?)(?:\s*\([^)]*\))?[^\n]*\n[\s\S]*?```text\n)([\s\S]*?)(\n```)/g

/**
 * Compact the verbose body of every embedded `[[tool-result]]` block in a text
 * blob (e.g. a relayed agent response), leaving prose untouched. Returns the
 * rewritten text + per-block stats.
 */
export function compactToolResultMarkdown(
  text: string,
  opts: CompactOptions = {},
): { text: string; stats: CompactionStats[] } {
  const stats: CompactionStats[] = []
  const out = text.replace(
    TOOL_RESULT_BLOCK,
    (match: string, prefix: string, name: string, body: string, fence: string) => {
      const r = compactToolOutput(name.trim() || 'tool', body, opts)
      stats.push(r.stats)
      return r.stats.applied ? `${prefix}${r.text}${fence}` : match
    },
  )
  return { text: out, stats }
}
