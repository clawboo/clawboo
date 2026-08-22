// Display/log-layer redaction — the last boundary before a credential would
// reach a browser response body or a log line. The storage layer (@clawboo/db's
// scrubSecrets) is the twin; these two compose as defense in depth, so a
// regression here is a real leak even though data is usually already scrubbed.
//
// SENSITIVE_VALUE_RES is deliberately an ALLOW-LIST, not universal shape
// coverage, so these tests assert the vendor patterns that are actually
// claimed — not "any secret-looking string".

import { describe, expect, it } from 'vitest'

import { REDACTION_MASK, redactJsonString, redactObject, redactValue } from '../redact'

describe('REDACTION_MASK', () => {
  it('is the four-bullet display mask (distinct from the storage layer’s [REDACTED])', () => {
    expect(REDACTION_MASK).toBe('••••')
  })
})

describe('redactValue', () => {
  it('leaves ordinary prose untouched', () => {
    expect(redactValue('hello world')).toBe('hello world')
  })

  it('masks the WHOLE value when the key looks like a credential', () => {
    expect(redactValue('anything at all', 'accessToken')).toBe(REDACTION_MASK)
    expect(redactValue('anything at all', 'clientSecret')).toBe(REDACTION_MASK)
    expect(redactValue('anything at all', 'authorization')).toBe(REDACTION_MASK)
  })

  it('lets numeric token telemetry through (the SAFE_COUNT_KEYS carve-out)', () => {
    // A key CONTAINING "token" that is a COUNT, not a credential.
    expect(redactValue(1234, 'inputTokens')).toBe(1234)
    expect(redactValue(5, 'tokens')).toBe(5)
    expect(redactValue(99, 'totalTokens')).toBe(99)
  })

  it('passes numbers, booleans and null through unchanged', () => {
    expect(redactValue(1.25)).toBe(1.25)
    expect(redactValue(true)).toBe(true)
    expect(redactValue(null)).toBeNull()
  })
})

describe('redactValue — credential value shapes', () => {
  it('masks vendor API keys embedded in free text', () => {
    expect(redactValue('key is sk-abcdefghijklmnop here')).toBe('key is •••• here')
    expect(redactValue('sk-ant-api03-AAAAAAAAAAAAAAAA')).toBe('••••')
    expect(redactValue('token ghp_ABCDEFGHIJKLMNOPQRST end')).toBe('token •••• end')
  })

  it('masks an Authorization: Bearer header value', () => {
    expect(redactValue('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: ••••')
  })

  it('masks env-var-style assignments a child process dumped to stderr', () => {
    expect(redactValue('OPENROUTER_API_KEY=sk-or-v1-abcdefghijkl')).toBe('••••')
    // Quote-aware, so a multi-word quoted secret is fully covered.
    expect(redactValue('DB_PASSWORD: "multi word secret" tail')).toBe('•••• tail')
  })

  it('masks a whole PEM private-key block (multi-line)', () => {
    const pem = 'x -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- y'
    expect(redactValue(pem)).toBe('x •••• y')
  })

  it('masks unlabelled, multiple, and dash-bearing PEM blocks', () => {
    expect(redactValue('-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----')).toBe('••••')
    const two =
      'a -----BEGIN EC PRIVATE KEY-----\nk1\n-----END EC PRIVATE KEY----- b ' +
      '-----BEGIN PRIVATE KEY-----\nk2\n-----END PRIVATE KEY----- c'
    expect(redactValue(two)).toBe('a •••• b •••• c')
    // An encrypted key carries `-` inside the body; the block must still go.
    const encrypted =
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,X\n\nk\n-----END RSA PRIVATE KEY-----'
    expect(redactValue(encrypted)).toBe('••••')
  })

  it('leaves a PEM header with no closing header untouched', () => {
    const open = 'note -----BEGIN RSA PRIVATE KEY-----\nMIIabc'
    expect(redactValue(open)).toBe(open)
  })

  it('stays linear on a blob of unclosed PEM headers', () => {
    const blob = '-----BEGIN PRIVATE KEY-----\n'.repeat(20000)
    const started = performance.now()
    expect(redactValue(blob)).toBe(blob)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('masks a JWT through BOTH paths (whole-string and embedded)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefg'
    // Whole-string: JWT_RE in maskString short-circuits to the bare mask.
    expect(redactValue(jwt)).toBe(REDACTION_MASK)
    // Embedded: the JWT entry in SENSITIVE_VALUE_RES replaces in place.
    expect(redactValue(`auth=${jwt} done`)).toBe('auth=•••• done')
  })

  it('leaves telemetry and hashes that merely look random alone', () => {
    expect(redactValue('build 9f2c1a4e8b7d')).toBe('build 9f2c1a4e8b7d')
    expect(redactValue('latency 1234ms')).toBe('latency 1234ms')
  })
})

describe('redactObject', () => {
  it('masks credential keys deeply, through arrays, while telemetry survives', () => {
    expect(
      redactObject({
        a: { b: { apiKey: 'x', inputTokens: 42, nested: ['sk-abcdefghijklmnop', 2] } },
      }),
    ).toEqual({
      a: { b: { apiKey: '••••', inputTokens: 42, nested: ['••••', 2] } },
    })
  })

  it('leaves a record of pure telemetry untouched', () => {
    const rec = { cost: 1.25, totalTokens: 100, ok: true, n: null }
    expect(redactObject(rec)).toEqual(rec)
  })

  it('masks on a CONTAINS match, so header-ish keys are caught', () => {
    expect(redactObject({ 'set-cookie': 'abc' })).toEqual({ 'set-cookie': '••••' })
    expect(redactObject({ private_key: 'abc' })).toEqual({ private_key: '••••' })
  })

  it('survives a circular object without recursing forever', () => {
    const c: Record<string, unknown> = { name: 'root' }
    c['self'] = c
    expect(redactObject(c)).toEqual({ name: 'root', self: '[Circular]' })
  })

  it('survives a circular array', () => {
    const a: unknown[] = [1]
    a.push(a)
    expect(redactObject(a)).toEqual([1, '[Circular]'])
  })

  it('keeps "author" — it only matches because it contains "auth"', () => {
    // SENSITIVE_KEY_RE is an unanchored contains-match including `auth`, so
    // `author` (one of the commonest fields in event/audit payloads) used to be
    // masked. The SAFE_COUNT_KEYS carve-out is what keeps it readable.
    expect(redactObject({ author: 'me' })).toEqual({ author: 'me' })
    expect(redactObject({ authors: ['a', 'b'] })).toEqual({ authors: ['a', 'b'] })
  })

  it('still masks the credential keys that "author" sits next to', () => {
    // The carve-out is EXACT-key, so it must not have widened the hole.
    expect(redactObject({ authorization: 'Basic abc' })).toEqual({ authorization: '••••' })
    expect(redactObject({ authToken: 'abc' })).toEqual({ authToken: '••••' })
  })

  it('renders a SHARED (non-circular) sub-object twice, not as [Circular]', () => {
    // The cycle guard tracks the current recursion PATH, not every object ever
    // visited — so a DAG renders in full. A visited-ever set would replace the
    // second occurrence with the '[Circular]' string and drop real data.
    const shared = { x: 1 }
    expect(redactObject({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } })
  })

  it('renders a repeated sub-object at sibling depth and in arrays', () => {
    const shared = { name: 'agent-1', inputTokens: 7 }
    expect(redactObject({ list: [shared, shared], nested: { deep: shared } })).toEqual({
      list: [
        { name: 'agent-1', inputTokens: 7 },
        { name: 'agent-1', inputTokens: 7 },
      ],
      nested: { deep: { name: 'agent-1', inputTokens: 7 } },
    })
  })

  it('still detects a cycle that is genuinely nested inside a shared node', () => {
    // The subtle case the path-tracking fix must not regress: `shared` appears
    // twice AND contains a real self-reference.
    const shared: Record<string, unknown> = { x: 1 }
    shared['self'] = shared
    expect(redactObject({ a: shared, b: shared })).toEqual({
      a: { x: 1, self: '[Circular]' },
      b: { x: 1, self: '[Circular]' },
    })
  })
})

describe('redactJsonString', () => {
  it('parses, masks keys + values, and re-stringifies valid JSON', () => {
    expect(redactJsonString('{"password":"p","totalTokens":9}')).toBe(
      '{"password":"••••","totalTokens":9}',
    )
  })

  it('falls back to a value-only scan when the field is not JSON', () => {
    expect(redactJsonString('not json sk-abcdefghijklmnop')).toBe('not json ••••')
  })

  it('returns empty strings, null and undefined unchanged', () => {
    expect(redactJsonString('')).toBe('')
    expect(redactJsonString(null)).toBeNull()
    expect(redactJsonString(undefined)).toBeUndefined()
  })
})
