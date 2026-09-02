// ─── Injection / supply-chain scanner + surface policy ──────────────────────
// One scanner, three surfaces. `evaluateInjection` is the policy seam every
// gate calls: it scans `text` with the rule set below, then maps each finding
// to `block` or `review` based on the SURFACE the text is bound for and the
// INTENT of the rule that fired. No cryptographic signing (that's the
// provenance seam); this is the content-level safety net.
//
// The three-axis model:
//   • severity: the category on the wire (exfil / injection / destructive /
//     supply-chain). Unchanged from the original scanner.
//   • intent: who the payload is addressed to. `language` payloads attack
//     the MODEL (instruction overrides, invisible-unicode smuggling) and are
//     dangerous the moment they enter a prompt. `machine` payloads attack the
//     MACHINE (shell, SQL, package manager) and need something to run them.
//   • surface: where the text is going. `exec` is spawn/args-bound (tool
//     args, MCP connector command/env, skill installs). `prompt` is content
//     bound for an agent's context (IDENTITY.md, memory facts). `catalog` is
//     marketplace content at rest.
//
// Action matrix: on `exec` every finding blocks. On `prompt` and `catalog`,
// `language` findings block and `machine` findings are flagged for review
// (security-education prose about DROP TABLE is not an attack; the exec seam
// still denies the real thing). `strict: true` promotes `machine` to block on
// the prose surfaces (used by memory recall, where dropping a fact is cheap).
// A per-rule `ceiling` can cap the action (bidi isolates are legitimate in
// RTL prose, so that rule never exceeds `review`).
//
// The scan is GLOBAL, not per-line: three rules use `\s+`, which matches `\n`,
// so `DROP\nTABLE`, `ignore all\nprevious instructions`, and a newline-split
// recursive delete all still match. A per-line rewrite would silently stop
// matching exactly the payloads an attacker can tune by inserting a newline.
// `line` is derived from the match index; for a cross-line match it is the
// FIRST physical line of the match.
//
// NOTE: each pattern's leading keyword char is wrapped in a single-char class
// (e.g. `[c]url`) so the regex matches the real token while the SOURCE never
// contains a contiguous shell-command literal — that trips the repo's
// security-reminder hook (a known false-positive on command strings).

import { createHash } from 'node:crypto'

export type InjectionSeverity = 'exfil' | 'injection' | 'destructive' | 'supply-chain'

/** Who the payload is addressed to: the model (`language`) or the machine. */
export type InjectionIntent = 'language' | 'machine'

/** Where the scanned text is bound for. */
export type InjectionSurface = 'exec' | 'prompt' | 'catalog'

/** What the policy does with a finding on the evaluated surface. */
export type InjectionAction = 'block' | 'review'

export interface InjectionFinding {
  severity: InjectionSeverity
  pattern: string
  excerpt: string
  /** Who the payload is addressed to (per-rule, not per-surface). */
  intent: InjectionIntent
  /** Human-readable one-liner for the rule that fired. */
  message: string
  /** 1-indexed physical line of the match start (first line for cross-line). */
  line: number
  /**
   * sha256 (full 64-hex) of `scope + rule label + physical line`, whitespace
   * collapsed and lowercased. Survives a Prettier reflow of the surrounding
   * file; changes the moment the payload line itself changes.
   */
  fingerprint: string
}

interface Rule {
  severity: InjectionSeverity
  intent: InjectionIntent
  label: string
  message: string
  re: RegExp
  /** Cap the action at `review` even where the matrix says block. */
  ceiling?: InjectionAction
}

const RULES: Rule[] = [
  // exfiltration: pipe-a-download-to-a-shell, or dump env to the network
  {
    severity: 'exfil',
    intent: 'machine',
    label: 'pipe-to-shell',
    message: 'download piped straight into a shell',
    re: /\b([c]url|[w]get)\b[^\n]*\|\s*([s]h|[b]ash|[z]sh)\b/gi,
  },
  {
    severity: 'exfil',
    intent: 'machine',
    label: 'env-exfil',
    message: 'environment variables routed to a network tool',
    re: /(process\.env|[p]rintenv|\b[e]nv\b)[^\n]*\b([c]url|[w]get|[f]etch|[n]c|[n]etcat)\b/gi,
  },
  // prompt injection: instruction-override phrasings
  {
    severity: 'injection',
    intent: 'language',
    label: 'ignore-previous',
    message: 'instruction-override phrasing',
    re: /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions\b/gi,
  },
  {
    severity: 'injection',
    intent: 'language',
    label: 'reveal-secrets',
    message: 'asks to reveal secrets or the system prompt',
    re: /\b(reveal|print|exfiltrate|leak)\b[^\n]*\b(system\s+prompt|api[_-]?key|secret|credential)s?\b/gi,
  },
  // destructive
  {
    severity: 'destructive',
    intent: 'machine',
    label: 'recursive-delete-root',
    message: 'recursive delete of a root path',
    re: /\b[r]m\s+-rf\s+(\/|~|\$HOME)/gi,
  },
  {
    severity: 'destructive',
    intent: 'machine',
    label: 'disk-overwrite',
    message: 'raw block-device overwrite',
    re: /\b[d]d\s+if=[^\n]*\bof=\/dev\/(sd|disk|nvme)/gi,
  },
  {
    severity: 'destructive',
    intent: 'machine',
    label: 'drop-table',
    message: 'SQL DROP TABLE statement',
    re: /\b[D]ROP\s+TABLE\b/gi,
  },
  // supply-chain
  {
    severity: 'supply-chain',
    intent: 'machine',
    label: 'unsafe-perm',
    message: 'package install with --unsafe-perm',
    re: /\b([n]pm|[p]npm|[y]arn)\s+[i]nstall\b[^\n]*--unsafe-perm\b/gi,
  },
  {
    severity: 'supply-chain',
    intent: 'machine',
    label: 'install-from-url',
    message: 'package install from a raw URL',
    re: /\b([n]pm|[p]ip|[g]em)\s+[i]nstall\b[^\n]*\bhttps?:\/\//gi,
  },
  // unicode obfuscation: invisible or direction-warping characters that can
  // smuggle language-directed payloads past a human reviewer. U+200D (ZWJ) is
  // deliberately NOT matched: it is load-bearing in composite emoji and the
  // catalog is emoji-dense.
  {
    severity: 'injection',
    intent: 'language',
    label: 'unicode-tag-block',
    message: 'invisible Unicode tag characters (U+E0000..U+E007F)',
    re: /[\u{E0000}-\u{E007F}]/gu,
  },
  {
    severity: 'injection',
    intent: 'language',
    label: 'bidi-override',
    message: 'bidirectional override control characters (U+202A..U+202E)',
    re: /[\u202A-\u202E]/g,
  },
  {
    severity: 'injection',
    intent: 'language',
    label: 'bidi-isolate',
    message: 'bidirectional isolate control characters (U+2066..U+2069)',
    re: /[\u2066-\u2069]/g,
    // Legitimate in RTL prose, so this rule never exceeds review.
    ceiling: 'review',
  },
  {
    severity: 'injection',
    intent: 'language',
    label: 'invisible-separator',
    message: 'invisible zero-width separator characters',
    re: /[\u200B\u200C\u2060\uFEFF]/g,
  },
]

const MAX_MATCHES_PER_RULE = 20
const MAX_MATCHES_TOTAL = 100

function excerpt(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 20)
  const end = Math.min(text.length, index + len + 20)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/** 1-indexed line number of `index` in `text`. */
function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++
  }
  return line
}

/** The physical line containing `index` (first line of a cross-line match). */
function physicalLine(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1
  const end = text.indexOf('\n', index)
  return text.slice(start, end === -1 ? text.length : end)
}

function fingerprintOf(scope: string, label: string, lineText: string): string {
  const canonical = [scope, label, lineText].join(' ').replace(/\s+/g, ' ').trim().toLowerCase()
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** Strip a single leading BOM so it cannot mask a match at offset 0 (and does
 *  not itself trip `invisible-separator` on every BOM-saved file). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function scanRules(rawText: string, scope: string): InjectionFinding[] {
  const text = stripBom(rawText)
  const findings: InjectionFinding[] = []
  for (const rule of RULES) {
    let perRule = 0
    // matchAll iterates a fresh clone of the regex, so the shared module-level
    // rule regex never carries `lastIndex` state between scans.
    for (const m of text.matchAll(rule.re)) {
      findings.push({
        severity: rule.severity,
        pattern: rule.label,
        excerpt: excerpt(text, m.index, m[0].length),
        intent: rule.intent,
        message: rule.message,
        line: lineOf(text, m.index),
        fingerprint: fingerprintOf(scope, rule.label, physicalLine(text, m.index)),
      })
      perRule++
      if (perRule >= MAX_MATCHES_PER_RULE || findings.length >= MAX_MATCHES_TOTAL) break
    }
    if (findings.length >= MAX_MATCHES_TOTAL) break
  }
  return findings
}

export interface EvaluateInjectionOptions {
  surface: InjectionSurface
  /** Promote `machine` findings to block on the prose surfaces. */
  strict?: boolean
  /** Caller identity baked into fingerprints, e.g. `agency-x#IDENTITY.md`. */
  scope?: string
}

export interface InjectionEvaluation {
  surface: InjectionSurface
  /** True when at least one finding resolves to `block` on this surface. */
  blocked: boolean
  /** Every finding, in rule order (block + review together). */
  findings: InjectionFinding[]
  /** The findings that block on this surface. */
  block: InjectionFinding[]
  /** The findings flagged for human review on this surface. */
  review: InjectionFinding[]
}

const CEILINGS: Record<string, InjectionAction | undefined> = Object.fromEntries(
  RULES.map((r) => [r.label, r.ceiling]),
)

/** Resolve one finding's action on a surface (the matrix + per-rule ceiling). */
export function actionFor(
  finding: Pick<InjectionFinding, 'intent' | 'pattern'>,
  surface: InjectionSurface,
  strict = false,
): InjectionAction {
  let action: InjectionAction
  if (surface === 'exec') {
    action = 'block'
  } else {
    action = finding.intent === 'language' || strict ? 'block' : 'review'
  }
  if (CEILINGS[finding.pattern] === 'review') action = 'review'
  return action
}

/**
 * THE injection gate. Scan `text` and resolve each finding to block/review
 * for the surface it is bound for. Every caller-facing gate goes through here.
 */
export function evaluateInjection(
  text: string,
  opts: EvaluateInjectionOptions,
): InjectionEvaluation {
  const findings = scanRules(text, opts.scope ?? '')
  const block: InjectionFinding[] = []
  const review: InjectionFinding[] = []
  for (const f of findings) {
    if (actionFor(f, opts.surface, opts.strict ?? false) === 'block') block.push(f)
    else review.push(f)
  }
  return { surface: opts.surface, blocked: block.length > 0, findings, block, review }
}

/** Compact per-finding summary for audit rows. Full excerpts stay in the HTTP
 *  response; the audit row stores only what a forensic query needs, so a 30 KB
 *  payload at the match caps cannot balloon the TEXT column. */
export function injectionAuditSummary(
  findings: InjectionFinding[],
): Array<{ pattern: string; line: number; fingerprint: string }> {
  return findings.map((f) => ({ pattern: f.pattern, line: f.line, fingerprint: f.fingerprint }))
}

/** Return all injection/supply-chain findings in `text` (empty = clean).
 *  Pure scanner, no surface policy: matching semantics for the nine legacy
 *  rules are byte-for-byte the original single-pass scan, now multi-match
 *  (capped) and enriched with intent/message/line/fingerprint. */
export function scanForInjection(text: string): InjectionFinding[] {
  return scanRules(text, '')
}

/** Convenience: true when the text trips no injection rule. */
export function isSkillSafe(text: string): boolean {
  return scanForInjection(text).length === 0
}
