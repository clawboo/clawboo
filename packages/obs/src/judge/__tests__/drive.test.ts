import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildJudgePrompt, driveStructuredJudge, extractJsonBlock } from '../drive'

const schema = z.object({ score: z.number(), reason: z.string() })

describe('extractJsonBlock', () => {
  it('extracts the first balanced top-level object, ignoring surrounding prose', () => {
    expect(extractJsonBlock('here it is: {"score": 1, "reason": "ok"} trailing')).toEqual({
      score: 1,
      reason: 'ok',
    })
  })
  it('handles nested braces', () => {
    expect(extractJsonBlock('{"a": {"b": 2}}')).toEqual({ a: { b: 2 } })
  })
  it('returns null when there is no JSON', () => {
    expect(extractJsonBlock('no json here')).toBeNull()
  })
  it('returns null on malformed JSON', () => {
    expect(extractJsonBlock('{"score": }')).toBeNull()
  })
})

describe('driveStructuredJudge', () => {
  it('parses a valid typed verdict', async () => {
    const r = await driveStructuredJudge({
      runText: async () => '{"score": 2, "reason": "good"}',
      schema,
    })
    expect(r.status).toBe('parsed')
    expect(r.value).toEqual({ score: 2, reason: 'good' })
  })
  it('treats empty output as a valid "nothing to report"', async () => {
    const r = await driveStructuredJudge({ runText: async () => '   ', schema })
    expect(r.status).toBe('empty')
    expect(r.value).toBeNull()
  })
  it('flags non-empty non-JSON (or schema-mismatch) as unparseable, never throws', async () => {
    const r1 = await driveStructuredJudge({ runText: async () => 'I refuse to answer', schema })
    expect(r1.status).toBe('unparseable')
    const r2 = await driveStructuredJudge({
      runText: async () => '{"score": "not a number"}',
      schema,
    })
    expect(r2.status).toBe('unparseable')
    expect(r2.value).toBeNull()
  })
})

describe('buildJudgePrompt', () => {
  it('produces a structured-output instruction with the way-out', () => {
    const p = buildJudgePrompt({ task: 'review X', shape: '{"score":0}', rubric: 'be strict' })
    expect(p).toContain('Output ONLY a single JSON object')
    expect(p).toContain('"Unknown"')
    expect(p).toContain('review X')
    expect(p).toContain('be strict')
  })
})
