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
    const line = raw.trimEnd()
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
    const line = raw.trimEnd()
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

/** Closing tags that end a visual block, so the text gets a line break there. */
const BLOCK_CLOSE_TAGS = new Set([
  'p',
  'div',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article',
])

/** Elements whose CONTENT is not prose, and goes with the tag. */
const OPAQUE_ELEMENTS = ['script', 'style']

const TAG_NAME_RE = /^<\s*(\/?)\s*([a-z][a-z0-9]*)/i

/**
 * Index just past `</name …>`, or -1 when the element never closes. Only ever
 * compares a fixed number of characters per candidate, so a document full of
 * unrelated closing tags costs one walk rather than a rescan.
 */
function endOfElement(s: string, from: number, name: string): number {
  let at = from
  for (;;) {
    at = s.indexOf('</', at)
    if (at === -1) return -1
    const nameAt = at + 2
    if (s.slice(nameAt, nameAt + name.length).toLowerCase() === name) {
      const gt = s.indexOf('>', nameAt + name.length)
      return gt === -1 ? -1 : gt + 1
    }
    at = nameAt
  }
}

export function htmlToText(output: string): string {
  // One forward pass that COPIES OUT the text between tags, rather than passes
  // that delete tags from the string. Deleting splices whatever surrounded a tag
  // back together, so `<scr<b>ipt>` becomes a working `<script>` the moment the
  // inner tag goes, and further passes are then needed to catch what the last
  // one built. Nothing is spliced here, so nothing can be reassembled: a `<`
  // that opens a tag leaves with it, and a `<` that opens nothing is text.
  const parts: string[] = []
  // An opaque element whose closing tag is missing exhausts that name: no later
  // opener can have one either, so the tail is walked once, not once per opener.
  const exhausted = new Set<string>()
  let i = 0

  while (i < output.length) {
    if (output[i] !== '<') {
      const next = output.indexOf('<', i)
      parts.push(output.slice(i, next === -1 ? output.length : next))
      if (next === -1) break
      i = next
      continue
    }

    if (output.startsWith('<!--', i)) {
      const end = output.indexOf('-->', i + 4)
      // An unterminated comment swallows the rest, as a browser treats it.
      i = end === -1 ? output.length : end + 3
      continue
    }

    const gt = output.indexOf('>', i + 1)
    // A `<` with no `>` anywhere after it is text, not a tag.
    if (gt === -1) {
      parts.push(output.slice(i))
      break
    }

    const parsed = output.slice(i, gt + 1).match(TAG_NAME_RE)
    const isClose = parsed?.[1] === '/'
    const name = parsed?.[2]?.toLowerCase() ?? ''

    if (!isClose && OPAQUE_ELEMENTS.includes(name) && !exhausted.has(name)) {
      const end = endOfElement(output, gt + 1, name)
      if (end === -1) exhausted.add(name)
      i = end === -1 ? gt + 1 : end
      continue
    }

    if (name === 'br' || (isClose && BLOCK_CLOSE_TAGS.has(name))) parts.push('\n')
    i = gt + 1
  }

  return (
    parts
      .join('')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // `&amp;` decodes last. Going first would turn `&amp;lt;` into `&lt;` and
      // then into `<`, decoding a sequence the author wrote to be READ as the
      // four characters `&lt;`.
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
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
  for (let i = 0; i < lines.length;) {
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
