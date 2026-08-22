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

// The `[[tool-result]] <name> (<id>)` header line (the `formatToolResultMarkdown`
// shape). The name runs to the first `(` or end of line and is trimmed by the
// caller, so no separate whitespace group competes with it for the same spaces.
// Whatever follows the name is swallowed by one run that has to begin at that
// `(`, rather than by an optional id group next to a second run-to-end-of-line:
// two such groups can both claim the same characters, which is what makes a
// header line cost more than one pass to reject.
//
// Anchored per line, because a header only ever starts one. Unanchored, a blob
// of `[[tool-result]](` with no line break anywhere would run the scan to the
// end of the input once per marker.
const TOOL_RESULT_HEADER = /^\[\[tool-result\]\]([^\n(]*)(?:\([^\n]*)?\n/gm
const FENCE_OPEN = '```text\n'
const FENCE_CLOSE = '\n```'

/**
 * Compact the verbose body of every embedded `[[tool-result]]` block in a text
 * blob (e.g. a relayed agent response), leaving prose untouched. Returns the
 * rewritten text + per-block stats.
 *
 * Each block is located in two steps: a regex for the header line, then plain
 * index scans for the fences that open and close the body. A single regex
 * spanning header-to-fence would have to skip arbitrary text with `[\s\S]*?`,
 * so every header that turned out to have no fenced body behind it would
 * re-scan the whole remaining blob. Index scans cost one pass per block no
 * matter how many bare `[[tool-result]]` markers the text carries.
 */
export function compactToolResultMarkdown(
  text: string,
  opts: CompactOptions = {},
): { text: string; stats: CompactionStats[] } {
  const stats: CompactionStats[] = []
  let out = ''
  let cursor = 0

  const headers = [...text.matchAll(TOOL_RESULT_HEADER)]
  for (let h = 0; h < headers.length; h++) {
    const m = headers[h]!
    // A header buried inside a body already consumed belongs to that body.
    if (m.index < cursor) continue
    const fenceStart = text.indexOf(FENCE_OPEN, m.index + m[0].length)
    // No opening fence left after this header means no later header can have
    // one either, so everything from here on is prose.
    if (fenceStart === -1) break
    // A fence that only turns up past the NEXT header belongs to that header.
    // Without this, an unfenced header would adopt a later block and label that
    // block's output with its own tool name, picking the wrong compaction rule.
    if (fenceStart >= (headers[h + 1]?.index ?? text.length)) continue
    const bodyStart = fenceStart + FENCE_OPEN.length
    const bodyEnd = text.indexOf(FENCE_CLOSE, bodyStart)
    if (bodyEnd === -1) break
    const blockEnd = bodyEnd + FENCE_CLOSE.length

    const r = compactToolOutput((m[1] ?? '').trim() || 'tool', text.slice(bodyStart, bodyEnd), opts)
    stats.push(r.stats)
    out += text.slice(cursor, m.index)
    out += r.stats.applied
      ? `${text.slice(m.index, bodyStart)}${r.text}${FENCE_CLOSE}`
      : text.slice(m.index, blockEnd)
    cursor = blockEnd
  }

  return { text: out + text.slice(cursor), stats }
}
