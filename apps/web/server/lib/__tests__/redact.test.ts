// Redact-on-display: the display/log-layer masker. Asserts credential-shaped keys
// + values are masked with the bullet string, numeric telemetry (token counts /
// cost) survives, nested objects + arrays are walked, and circular structures are
// handled. Imports through the server re-export (which re-exports @clawboo/logger).

import { describe, expect, it } from 'vitest'

import { redactJsonString, redactObject, redactValue, REDACTION_MASK } from '../redact'

describe('redactObject (display-layer)', () => {
  it('masks credential-looking keys regardless of value', () => {
    const out = redactObject({
      apiKey: 'whatever',
      api_key: 'x',
      token: 'abc',
      accessToken: 'y',
      password: 'p',
      authorization: 'Bearer z',
      clientSecret: 's',
      cookie: 'sid=1',
      nested: { privateKey: 'pk' },
    }) as Record<string, unknown>
    expect(out.apiKey).toBe(REDACTION_MASK)
    expect(out.api_key).toBe(REDACTION_MASK)
    expect(out.token).toBe(REDACTION_MASK)
    expect(out.accessToken).toBe(REDACTION_MASK)
    expect(out.password).toBe(REDACTION_MASK)
    expect(out.authorization).toBe(REDACTION_MASK)
    expect(out.clientSecret).toBe(REDACTION_MASK)
    expect(out.cookie).toBe(REDACTION_MASK)
    expect((out.nested as Record<string, unknown>).privateKey).toBe(REDACTION_MASK)
  })

  it('PRESERVES numeric token counts + cost (SAFE_COUNT_KEYS)', () => {
    const out = redactObject({
      inputTokens: 1234,
      outputTokens: 56,
      cachedInputTokens: 7,
      totalTokens: 1290,
      tokensPerMinute: 42,
      costUsd: 0.0123,
      model: 'claude',
    }) as Record<string, number | string>
    expect(out.inputTokens).toBe(1234)
    expect(out.outputTokens).toBe(56)
    expect(out.cachedInputTokens).toBe(7)
    expect(out.totalTokens).toBe(1290)
    expect(out.tokensPerMinute).toBe(42)
    expect(out.costUsd).toBe(0.0123)
    expect(out.model).toBe('claude')
  })

  it('masks credential-shaped VALUES embedded in strings under safe keys', () => {
    const out = redactObject({
      message: 'failed with Authorization: Bearer abcdef123456 and key sk-ant-abcdef123456789',
      note: 'plain text is fine',
    }) as Record<string, string>
    expect(out.message).toContain(REDACTION_MASK)
    expect(out.message).not.toContain('Bearer abcdef123456')
    expect(out.message).not.toContain('sk-ant-abcdef123456789')
    expect(out.note).toBe('plain text is fine')
  })

  it('masks a bare JWT value', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummsignature123'
    const out = redactObject({ data: jwt }) as Record<string, string>
    expect(out.data).toBe(REDACTION_MASK)
  })

  it('masks no-prefix credential VALUES under benign keys (PEM / GitLab / Google by SHAPE)', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\nEFAASCBKcw\n-----END PRIVATE KEY-----'
    const out = redactObject({
      blob: pem,
      note: `glpat-${'C'.repeat(20)}`,
      content: `AIza${'B'.repeat(35)}`,
    }) as Record<string, string>
    expect(out.blob).not.toContain('BEGIN PRIVATE KEY')
    expect(out.blob).toBe(REDACTION_MASK)
    expect(out.note).toBe(REDACTION_MASK)
    expect(out.content).toBe(REDACTION_MASK)
  })

  it('walks arrays of mixed types', () => {
    const out = redactObject({
      items: [{ token: 'a' }, 'sk-ant-abcdefghijkl0', 42, { inputTokens: 9 }],
    }) as { items: unknown[] }
    expect((out.items[0] as Record<string, unknown>).token).toBe(REDACTION_MASK)
    expect(out.items[1]).toBe(REDACTION_MASK)
    expect(out.items[2]).toBe(42)
    expect((out.items[3] as Record<string, unknown>).inputTokens).toBe(9)
  })

  it('leaves a clean object untouched (structurally equal, fresh clone)', () => {
    const input = { a: 1, b: 'hello', c: { d: true, e: [1, 2, 3] } }
    const out = redactObject(input)
    expect(out).toEqual(input)
    expect(out).not.toBe(input)
  })

  it('survives circular references', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const out = redactObject(a) as Record<string, unknown>
    expect(out.name).toBe('a')
    expect(out.self).toBe('[Circular]')
  })

  it('redactValue masks when given a sensitive key, else scans the string', () => {
    expect(redactValue('anything', 'apiKey')).toBe(REDACTION_MASK)
    expect(redactValue('plain', 'note')).toBe('plain')
    expect(redactValue(99, 'inputTokens')).toBe(99)
  })

  it('redactJsonString masks credential keys inside a JSON-string field (the obs/audit shape)', () => {
    // The brief's acceptance shape: an event payload with a sensitive header.
    const stored = JSON.stringify({ headers: { authorization: 'Bearer xyz' }, inputTokens: 5 })
    const out = redactJsonString(stored)
    const parsed = JSON.parse(out) as { headers: { authorization: string }; inputTokens: number }
    expect(parsed.headers.authorization).toBe(REDACTION_MASK)
    expect(out).not.toContain('Bearer xyz')
    expect(parsed.inputTokens).toBe(5) // counts survive
  })

  it('redactJsonString value-scans a non-JSON string', () => {
    const out = redactJsonString('raw log line with sk-ant-abcdef123456789 inside')
    expect(out).toContain(REDACTION_MASK)
    expect(out).not.toContain('sk-ant-abcdef123456789')
  })

  it('masks an env-style assignment (CLI dumping its env), quote-aware', () => {
    // A non-prefixed value under a secret-shaped key would otherwise slip through.
    const out = redactValue('OPENAI_API_KEY="abc 123" then more', 'message') as string
    expect(out).toContain(REDACTION_MASK)
    expect(out).not.toContain('abc 123')
    expect(out).toContain('then more') // trailing prose survives
  })
})
