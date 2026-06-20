// @clawboo/compaction — pass-through-safe, failure-preserving tool-output
// compaction. Pure + browser-safe (runs client-side between an adapter's
// tool-result and context insertion). Cuts verbose tool output before it
// re-enters context, and never compresses away an error.

export { compactToolOutput, compactToolResultMarkdown } from './compact'

export {
  BUILTIN_RULES,
  FALLBACK_RULE_ID,
  FAILURE_RE,
  compactGitStatus,
  compactTestOutput,
  htmlToText,
  shortenUrls,
  dedupAndElide,
  failureLines,
} from './rules'

export type { CompactionRule, CompactionResult, CompactionStats, CompactOptions } from './types'
