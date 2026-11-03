// The env-assignment scrub rule (added for the "CLI dumps its env to stderr on
// crash" case) must FULLY redact a detected secret — including a quoted value
// that contains whitespace — without over-redacting the trailing prose.
//
// The saved-value pass masks a registered value of any shape, in every spelling
// it takes in stored text, without touching object keys or short ordinary words.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MIN_KNOWN_SECRET_LENGTH,
  registerKnownSecretSource,
  scrubArgsSummary,
  scrubResultSummary,
  scrubSecrets,
} from '../scrub'

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

describe('saved secret values', () => {
  // Shaped like a Groq key: none of the patterns above matches it.
  const KEY = 'gsk_9fQx2LmZ7tVbR4cWnY8pKdHs3JgA6eUiTo1MrXyNqBvCzLw5'
  let values: Set<string>

  beforeEach(() => {
    values = new Set([KEY])
    registerKnownSecretSource(() => values)
  })
  afterEach(() => registerKnownSecretSource(null))

  it('masks a value no pattern recognises, in free text and in every leaf', () => {
    expect(scrubResultSummary(`printenv: ${KEY}\n`)).toBe('printenv: [REDACTED]\n')
    expect(scrubSecrets({ a: [`x ${KEY} y`], b: { c: KEY } })).toEqual({
      a: ['x [REDACTED] y'],
      b: { c: '[REDACTED]' },
    })
    expect(scrubArgsSummary({ command: `curl -H "x-api-key: ${KEY}"` })).not.toContain(KEY)
  })

  it('is a no-op without a source, as before', () => {
    registerKnownSecretSource(null)
    expect(scrubResultSummary(KEY)).toBe(KEY)
  })

  it('masks the JSON-escaped spellings of a value', () => {
    const quoted = 'abc"def\\ghi/jkl-0123456789'
    values = new Set([quoted])
    const json = JSON.stringify({ v: quoted })
    expect(scrubResultSummary(json)).toBe('{"v":"[REDACTED]"}')
    // Some encoders also escape the forward slash.
    expect(scrubResultSummary(json.replace('/', '\\/'))).toBe('{"v":"[REDACTED]"}')
  })

  it('masks the URL-encoded spellings of a value, in either hex case', () => {
    const token = 'ya29.A0Ab+Cd/Ef==Gh9iJk(Lm)~No'
    values = new Set([token])
    const uri = encodeURIComponent(token)
    const form = new URLSearchParams({ t: token }).toString()
    expect(scrubResultSummary(`?t=${uri}`)).toBe('?t=[REDACTED]')
    const lowerHex = uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
    expect(lowerHex).not.toBe(uri)
    expect(scrubResultSummary(`?t=${lowerHex}`)).toBe('?t=[REDACTED]')
    expect(scrubResultSummary(form)).toBe('t=[REDACTED]')
  })

  it('leaves object keys intact, even one a saved value spells', () => {
    values = new Set(['conversationSummaryText'])
    expect(scrubSecrets({ conversationSummaryText: 'hello' })).toEqual({
      conversationSummaryText: 'hello',
    })
    expect(scrubArgsSummary({ conversationSummaryText: 'hello' })).toBe(
      '{"conversationSummaryText":"hello"}',
    )
  })

  it(`ignores values shorter than ${MIN_KNOWN_SECRET_LENGTH} characters`, () => {
    values = new Set(['postgres', 'a'.repeat(MIN_KNOWN_SECRET_LENGTH - 1)])
    expect(scrubResultSummary('use postgres here')).toBe('use postgres here')
  })

  it('masks overlapping and adjacent values as one run, leaving no tail', () => {
    const a = 'AAAAbbbbCCCCdddd'
    const b = 'CCCCddddEEEEffff'
    values = new Set([a, b])
    expect(scrubResultSummary('<AAAAbbbbCCCCddddEEEEffff>')).toBe('<[REDACTED]>')
    expect(scrubResultSummary(`${a}${a}`)).toBe('[REDACTED]')
    expect(scrubResultSummary(`${a} ${a}`)).toBe('[REDACTED] [REDACTED]')
  })

  it('picks up a changed set at once', () => {
    expect(scrubResultSummary(KEY)).toBe('[REDACTED]')
    const next = 'xai-Zt4Qp8LmX2vB7nR3cK9dW5sH1gJ6yA0eUfToMrNqVbCzLwPx'
    values = new Set([next])
    expect(scrubResultSummary(`${KEY} ${next}`)).toBe(`${KEY} [REDACTED]`)
  })

  it('keeps the values it last had when the source throws', () => {
    let fail = false
    registerKnownSecretSource(() => {
      if (fail) throw new Error('vault unreadable')
      return values
    })
    expect(scrubResultSummary(KEY)).toBe('[REDACTED]')
    fail = true
    expect(scrubResultSummary(KEY)).toBe('[REDACTED]')
  })

  it('stays fast on a large output', () => {
    values = new Set(Array.from({ length: 20 }, (_, i) => `${KEY}${i}`))
    const big = `${'lorem ipsum dolor sit amet '.repeat(200_000)}${KEY}7 end`
    const started = performance.now()
    const out = scrubResultSummary(big, big.length)
    const ms = performance.now() - started
    expect(out.endsWith('[REDACTED] end')).toBe(true)
    // ~5 MB through 20 values and every spelling: a regression to a quadratic
    // scan would take seconds here.
    expect(ms).toBeLessThan(2_000)
  })
})
