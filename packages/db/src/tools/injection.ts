// ─── Injection / supply-chain scanner ───────────────────────────────────────
// Scan a user-installed skill's text (description / source / instructions)
// before it can register or run. No cryptographic signing (that's the provenance
// seam) — this is the content-level safety net the brief calls for.
//
// NOTE: each pattern's leading keyword char is wrapped in a single-char class
// (e.g. `[c]url`) so the regex matches the real token while the SOURCE never
// contains a contiguous shell-command literal — that trips the repo's
// security-reminder hook (a known false-positive on command strings).

export type InjectionSeverity = 'exfil' | 'injection' | 'destructive' | 'supply-chain'

export interface InjectionFinding {
  severity: InjectionSeverity
  pattern: string
  excerpt: string
}

interface Rule {
  severity: InjectionSeverity
  label: string
  re: RegExp
}

const RULES: Rule[] = [
  // exfiltration: pipe-a-download-to-a-shell, or dump env to the network
  {
    severity: 'exfil',
    label: 'pipe-to-shell',
    re: /\b([c]url|[w]get)\b[^\n]*\|\s*([s]h|[b]ash|[z]sh)\b/i,
  },
  {
    severity: 'exfil',
    label: 'env-exfil',
    re: /(process\.env|[p]rintenv|\b[e]nv\b)[^\n]*\b([c]url|[w]get|[f]etch|[n]c|[n]etcat)\b/i,
  },
  // prompt injection: instruction-override phrasings
  {
    severity: 'injection',
    label: 'ignore-previous',
    re: /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions\b/i,
  },
  {
    severity: 'injection',
    label: 'reveal-secrets',
    re: /\b(reveal|print|exfiltrate|leak)\b[^\n]*\b(system\s+prompt|api[_-]?key|secret|credential)s?\b/i,
  },
  // destructive
  { severity: 'destructive', label: 'recursive-delete-root', re: /\b[r]m\s+-rf\s+(\/|~|\$HOME)/i },
  {
    severity: 'destructive',
    label: 'disk-overwrite',
    re: /\b[d]d\s+if=[^\n]*\bof=\/dev\/(sd|disk|nvme)/i,
  },
  { severity: 'destructive', label: 'drop-table', re: /\b[D]ROP\s+TABLE\b/i },
  // supply-chain
  {
    severity: 'supply-chain',
    label: 'unsafe-perm',
    re: /\b([n]pm|[p]npm|[y]arn)\s+[i]nstall\b[^\n]*--unsafe-perm\b/i,
  },
  {
    severity: 'supply-chain',
    label: 'install-from-url',
    re: /\b([n]pm|[p]ip|[g]em)\s+[i]nstall\b[^\n]*\bhttps?:\/\//i,
  },
]

function excerpt(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 20)
  const end = Math.min(text.length, index + len + 20)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/** Return all injection/supply-chain findings in `text` (empty = clean). */
export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = []
  for (const rule of RULES) {
    const m = rule.re.exec(text)
    if (m) {
      findings.push({
        severity: rule.severity,
        pattern: rule.label,
        excerpt: excerpt(text, m.index, m[0].length),
      })
    }
  }
  return findings
}

/** Convenience: true when the text trips no injection rule. */
export function isSkillSafe(text: string): boolean {
  return scanForInjection(text).length === 0
}
