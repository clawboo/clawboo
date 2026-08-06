// The env-assignment scrub rule (added for the "CLI dumps its env to stderr on
// crash" case) must FULLY redact a detected secret — including a quoted value
// that contains whitespace — without over-redacting the trailing prose.

import { describe, expect, it } from 'vitest'

import { scrubResultSummary, scrubSecrets } from '../scrub'

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

describe('scrubSecrets — SAFE_COUNT_KEYS carve-outs', () => {
  it('keeps token COUNTS, which only match because they contain "token"', () => {
    // Without the carve-out these are stored as the string "[REDACTED]" and then
    // summed as strings in the obs metrics.
    expect(scrubSecrets({ inputTokens: 12, totalTokens: 34 })).toEqual({
      inputTokens: 12,
      totalTokens: 34,
    })
  })

  it('keeps "author", which only matches because it contains "auth"', () => {
    // Mirrors the same carve-out in @clawboo/logger's redact.ts — the two layers
    // are documented as kept in sync, so an author field must survive BOTH the
    // storage scrub and the display mask.
    expect(scrubSecrets({ author: 'me', authors: ['a', 'b'] })).toEqual({
      author: 'me',
      authors: ['a', 'b'],
    })
  })

  it('still redacts the credential keys those carve-outs sit next to', () => {
    // Exact-key matching, so the carve-out must not have widened the hole.
    expect(scrubSecrets({ authorization: 'Basic abc', accessToken: 'x' })).toEqual({
      authorization: '[REDACTED]',
      accessToken: '[REDACTED]',
    })
  })
})
