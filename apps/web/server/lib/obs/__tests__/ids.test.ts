import { describe, expect, it } from 'vitest'

import {
  formatTraceparent,
  hexId,
  parseTraceparent,
  rootSpanIdFor,
  spanIdFor,
  traceIdFor,
} from '../ids'

describe('obs ids', () => {
  it('traceIdFor / spanIdFor are deterministic with the right hex length', () => {
    expect(traceIdFor('mission-1')).toBe(traceIdFor('mission-1'))
    expect(traceIdFor('mission-1')).toHaveLength(32)
    expect(spanIdFor('task-1')).toBe(spanIdFor('task-1'))
    expect(spanIdFor('task-1')).toHaveLength(16)
    expect(spanIdFor('task-1')).not.toBe(spanIdFor('task-2'))
  })

  it('rootSpanIdFor differs from the run span id for the same key', () => {
    expect(rootSpanIdFor('m')).not.toBe(spanIdFor('m'))
    expect(rootSpanIdFor('m')).toHaveLength(16)
  })

  it('formatTraceparent / parseTraceparent round-trip', () => {
    const tp = formatTraceparent(traceIdFor('m'), spanIdFor('t'))
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(parseTraceparent(tp)).toEqual({ traceId: traceIdFor('m'), spanId: spanIdFor('t') })
  })

  it('parseTraceparent rejects malformed input', () => {
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent('')).toBeNull()
    expect(parseTraceparent('garbage')).toBeNull()
    expect(parseTraceparent('00-short-xx-01')).toBeNull()
    expect(parseTraceparent(`00-${'g'.repeat(32)}-${'0'.repeat(16)}-01`)).toBeNull() // non-hex
  })

  it('hexId truncates to the requested byte length', () => {
    expect(hexId('x', 8)).toHaveLength(16)
    expect(hexId('x', 16)).toHaveLength(32)
  })
})
