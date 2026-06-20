// Builtin compaction rules. Each is a pure string transform, independently
// testable. They sniff CONTENT (not just the tool name) because clawboo's tool
// granularity is coarse — a single shell tool may emit version-control status
// or test-runner output — so the output SHAPE, not the tool name, is the
// reliable signal. No process spawning here: these are pure text transforms.

import type { CompactionRule } from './types'

/** Lines that look like an error/failure — never elided by generic compaction. */
export const FAILURE_RE =
  /(\berror\b|err!|\bexception\b|traceback|\bfatal\b|\bfailure\b|\bfailed\b|\bpanic\b|✗|✘|✖|×)/i

/** Extract every failure-looking line from a blob (used by the safety check). */
export function failureLines(text: string): string[] {
  return text.split('\n').filter((l) => FAILURE_RE.test(l))
}

// ─── version-control status → changed files only ─────────────────────────────

export function compactGitStatus(output: string): string {
  const kept: string[] = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (/^\s*\(use /.test(line)) continue // drop the "(use ...)" hint lines
    if (/^On branch /.test(line)) kept.push(line)
    else if (/^Your branch /.test(line)) kept.push(line)
    else if (
      /(Changes not staged|Changes to be committed|Untracked files|Changes not staged for commit):/.test(
        line,
      )
    )
      kept.push(line)
    else if (/^\s+(modified|new file|deleted|renamed|copied|typechange|both modified):/i.test(line))
      kept.push(line.trim())
    else if (/^\s*[MADRCU?!]{1,2}\s+\S/.test(line))
      kept.push(line.trim()) // porcelain
    else if (/^\t\S/.test(raw)) kept.push(line.trim()) // tab-indented file under a header
  }
  return kept.length ? kept.join('\n') : output
}

// ─── test runner → failures + summary only ───────────────────────────────────

export function compactTestOutput(output: string): string {
  const kept: string[] = []
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (FAILURE_RE.test(line))
      kept.push(line) // keep every failure line
    else if (/(Tests?|Test Files|Suites?):/i.test(line))
      kept.push(line) // keep summaries
    else if (/\b\d+\s+(passed|passing|failed|failing|skipped|pending)\b/i.test(line))
      kept.push(line)
    // pass lines (✓ / PASS / ok N) are intentionally dropped
  }
  return kept.length ? kept.join('\n') : output
}

// ─── HTML → text (linear, no parser/heavy dep) ───────────────────────────────

export function htmlToText(output: string): string {
  return output
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ─── long-URL shortening ─────────────────────────────────────────────────────

const URL_RE = /(https?:\/\/[^\s)<>"']+)/g
const MAX_URL_LEN = 80

export function shortenUrls(output: string): string {
  return output.replace(URL_RE, (url) => {
    if (url.length <= MAX_URL_LEN) return url
    const m = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(url)
    const host = m ? m[1] : url.slice(0, 32)
    return `${host}/…[+${url.length - host.length} chars]`
  })
}

// ─── dedup + head/tail elision (the catch-all) ───────────────────────────────

export function dedupAndElide(
  output: string,
  opts: { headLines?: number; tailLines?: number } = {},
): string {
  const head = opts.headLines ?? 40
  const tail = opts.tailLines ?? 20

  // 1) Collapse consecutive identical lines into "<line>  (×N)".
  const lines = output.split('\n')
  const deduped: string[] = []
  for (let i = 0; i < lines.length; ) {
    let j = i + 1
    while (j < lines.length && lines[j] === lines[i]) j++
    const run = j - i
    deduped.push(run > 1 ? `${lines[i]}  (×${run})` : lines[i])
    i = j
  }

  // 2) Head/tail elision — but keep any failure line from the elided middle.
  if (deduped.length <= head + tail + 1) return deduped.join('\n')
  const middle = deduped.slice(head, deduped.length - tail)
  const keptFailures = middle.filter((l) => FAILURE_RE.test(l))
  const elided = middle.length - keptFailures.length
  return [
    ...deduped.slice(0, head),
    `… [${elided} lines elided]${keptFailures.length ? ` (kept ${keptFailures.length} error line(s) below)` : ''} …`,
    ...keptFailures,
    ...deduped.slice(deduped.length - tail),
  ].join('\n')
}

// ─── The builtin rule set (content-sniffing matchers) ────────────────────────

export const BUILTIN_RULES: CompactionRule[] = [
  {
    id: 'git-status',
    matches: (_t, o) =>
      /On branch |Changes not staged for commit:|Untracked files:|nothing to commit|Changes to be committed:/.test(
        o,
      ),
    compact: compactGitStatus,
  },
  {
    id: 'test-output',
    matches: (_t, o) => /(✓|✗|\bPASS\b|\bFAIL\b|Test Files|\bTests:|\d+ (passing|failing))/.test(o),
    compact: compactTestOutput,
  },
  {
    id: 'html-to-text',
    matches: (_t, o) =>
      /<!DOCTYPE|<html\b|<body\b|<div\b|(<[a-z]+[^>]*>[\s\S]*<\/[a-z]+>)/i.test(o),
    compact: htmlToText,
  },
]

/** The catch-all id used when no content rule matches. */
export const FALLBACK_RULE_ID = 'dedup-elide'
