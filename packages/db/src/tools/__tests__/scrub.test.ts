// The env-assignment scrub rule (added for the "CLI dumps its env to stderr on
// crash" case) must FULLY redact a detected secret — including a quoted value
// that contains whitespace — without over-redacting the trailing prose.

import { describe, expect, it } from 'vitest'

import { scrubResultSummary } from '../scrub'

describe('scrubResultSummary — env-assignment redaction is quote-aware', () => {
  it('redacts a double-quoted multi-word secret in full, keeps trailing prose', () => {
    const out = scrubResultSummary('MY_SECRET="two words" remainder')
    expect(out).not.toContain('two words')
    expect(out).not.toContain('words"')
    expect(out).toContain('remainder')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts a single-quoted multi-word secret in full', () => {
    const out = scrubResultSummary("API_TOKEN='abc def' tail")
    expect(out).not.toContain('abc def')
    expect(out).toContain('tail')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts an unquoted env value but keeps the following word', () => {
    const out = scrubResultSummary('DB_PASSWORD: hunter2 trailing')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('trailing')
    expect(out).toContain('[REDACTED]')
  })
})
