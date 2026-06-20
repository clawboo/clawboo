import { describe, expect, it } from 'vitest'

import { criticOutputSchema, findingSchema, verificationResultSchema } from '../index'

describe('findingSchema', () => {
  it('fills defaults for a terse model finding', () => {
    const f = findingSchema.parse({ severity: 'crash', title: 'segfault' })
    expect(f).toMatchObject({
      severity: 'crash',
      title: 'segfault',
      body: '',
      filePath: null,
      startLine: null,
      confidence: 0.5,
    })
  })
  it('rejects an empty title and an unknown severity', () => {
    expect(findingSchema.safeParse({ severity: 'crash', title: '' }).success).toBe(false)
    expect(findingSchema.safeParse({ severity: 'nope', title: 'x' }).success).toBe(false)
  })
})

describe('criticOutputSchema', () => {
  it('parses a bare findings array', () => {
    const out = criticOutputSchema.parse({
      findings: [{ severity: 'security', title: 'token leak' }],
    })
    expect(out.findings).toHaveLength(1)
  })
  it('defaults to empty findings', () => {
    expect(criticOutputSchema.parse({}).findings).toEqual([])
  })
})

describe('verificationResultSchema', () => {
  const attempt = {
    attempt: 1,
    at: 1000,
    deterministic: { command: 'pnpm test', exitCode: 0, passed: true, durationMs: 5 },
    critic: { ran: false },
    status: 'pass' as const,
  }

  it('parses a valid result and fills nested defaults', () => {
    const r = verificationResultSchema.parse({
      status: 'pass',
      attempts: [attempt],
      updatedAt: 1000,
    })
    expect(r.debtNotes).toEqual([])
    expect(r.attempts[0]?.structuredError).toBeNull()
    expect(r.attempts[0]?.critic.findings).toEqual([])
  })
  it('rejects prose and an empty attempts array (never accept untyped verdicts)', () => {
    expect(verificationResultSchema.safeParse('looks good to me').success).toBe(false)
    expect(
      verificationResultSchema.safeParse({ status: 'pass', attempts: [], updatedAt: 1 }).success,
    ).toBe(false)
  })
})
