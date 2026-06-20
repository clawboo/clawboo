import { describe, expect, it } from 'vitest'

import { assembleTiers, dateStamp, sortToolDefs } from '../index'

describe('prompt-tier cache discipline', () => {
  describe('assembleTiers', () => {
    it('keeps the stable prefix byte-identical across turns when only volatile changes', () => {
      const stable = 'You are Builder Boo. Tools: read, write.'
      const context = 'Team manifest: A, B, C.'
      const builds = [0, 1, 2, 3, 4].map((n) =>
        assembleTiers({ stable, context, volatile: `turn ${n} — memory snapshot ${n}` }),
      )
      const first = builds[0]
      for (const b of builds) {
        expect(b.stablePrefix).toBe(first.stablePrefix)
        expect(b.stablePrefixBytes).toBe(first.stablePrefixBytes)
        expect(b.cacheBreakpoints).toEqual(first.cacheBreakpoints)
      }
      // The volatile tail differs, so the full prompts differ.
      expect(builds[0].prompt).not.toBe(builds[1].prompt)
      // The stable prefix is genuinely the head of every prompt.
      for (const b of builds) expect(b.prompt.startsWith(b.stablePrefix)).toBe(true)
    })

    it('orders tiers stable → context → volatile and skips empty tiers cleanly', () => {
      const a = assembleTiers({ stable: 'S', context: 'C', volatile: 'V' })
      expect(a.prompt).toBe('S\n\nC\n\nV')
      expect(a.stablePrefix).toBe('S\n\nC')
      const noContext = assembleTiers({ stable: 'S', context: '', volatile: 'V' })
      expect(noContext.prompt).toBe('S\n\nV')
      expect(noContext.stablePrefix).toBe('S')
      expect(noContext.cacheBreakpoints).toHaveLength(1) // no context breakpoint
    })

    it('reports a context breakpoint only when context is present', () => {
      expect(assembleTiers({ stable: 'S', context: 'C', volatile: '' }).cacheBreakpoints).toEqual([
        { offset: 1, label: 'stable' }, // byteLen('S') = 1
        { offset: 4, label: 'context' }, // byteLen('S\n\nC') = 4
      ])
    })
  })

  describe('sortToolDefs', () => {
    it('is order-insensitive and non-mutating', () => {
      const a = [{ name: 'write' }, { name: 'bash' }, { name: 'read' }]
      const b = [{ name: 'read' }, { name: 'write' }, { name: 'bash' }]
      expect(sortToolDefs(a).map((t) => t.name)).toEqual(['bash', 'read', 'write'])
      expect(sortToolDefs(a).map((t) => t.name)).toEqual(sortToolDefs(b).map((t) => t.name))
      // input untouched
      expect(a.map((t) => t.name)).toEqual(['write', 'bash', 'read'])
    })
  })

  describe('dateStamp', () => {
    it('is date-only — never minute/second precision', () => {
      const s = dateStamp(new Date('2026-06-03T17:42:09.123Z'))
      expect(s).toBe('2026-06-03')
      expect(s).not.toContain(':')
      expect(/^\d{4}-\d{2}-\d{2}$/.test(s)).toBe(true)
    })
  })
})
