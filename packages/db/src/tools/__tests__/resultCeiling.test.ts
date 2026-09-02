// The bounded view a model gets in place of an oversized tool result.
//
// The properties worth pinning are the ones that separate this from plain
// truncation: a result that fits is untouched, an oversized one always carries
// the handle and the literal next call, and the view never exceeds the budget it
// was given even once the notice is added back.

import { describe, expect, it } from 'vitest'

import { buildCeilingView } from '../resultCeiling'

const B = (s: string) => new TextEncoder().encode(s).length
const opts = (over: Partial<Parameters<typeof buildCeilingView>[1]> = {}) => ({
  budgetBytes: 800,
  handle: 'tr_9f2c81a4b6d0e1f2',
  toolName: 'mcp__composio__COMPOSIO_SEARCH_TOOLS',
  ...over,
})

describe('buildCeilingView', () => {
  it('leaves a result that fits completely untouched', () => {
    const text = 'a short answer'
    const r = buildCeilingView(text, opts())
    expect(r.text).toBe(text)
    expect(r.applied).toBe(false)
  })

  it('never exceeds the budget, notice included', () => {
    // The failure this prevents: reserving room for the notice AFTER cutting the
    // content, which produces a view larger than the budget that was the whole
    // reason for cutting.
    for (const budget of [400, 800, 4096, 20_000]) {
      const r = buildCeilingView('x'.repeat(500_000), opts({ budgetBytes: budget }))
      expect(r.shownBytes).toBeLessThanOrEqual(budget)
      expect(B(r.text)).toBe(r.shownBytes)
    }
  })

  it('states the size, the handle, and the literal next call', () => {
    // A notice that only says "truncated" leaves the model to invent a recovery,
    // and the documented failure is that it invents none and answers from the
    // prefix as if it were the whole result.
    const r = buildCeilingView('y'.repeat(50_000), opts())
    expect(r.text).toContain('50000 bytes total')
    expect(r.text).toContain('tr_9f2c81a4b6d0e1f2')
    expect(r.text).toContain('read_tool_result')
    expect(r.text).toContain('"offset":0')
    expect(r.text).toContain('"search"')
    // And it tells the model not to answer as though it read everything.
    expect(r.text).toContain('Answer only from what you have actually read')
  })

  it('keeps the beginning AND the end, and names the gap', () => {
    const text = `HEAD_MARKER${'m'.repeat(40_000)}TAIL_MARKER`
    const r = buildCeilingView(text, opts({ budgetBytes: 2_000 }))
    expect(r.text).toContain('HEAD_MARKER')
    expect(r.text).toContain('TAIL_MARKER')
    expect(r.text).toMatch(/\.\.\. \d+ bytes omitted \(byte offsets \d+ to \d+\) \.\.\./)
  })

  it('says plainly that nothing is recoverable when the store failed', () => {
    // Promising retrieval against a handle that does not exist would send the
    // model into a paging loop it can never finish.
    const r = buildCeilingView('z'.repeat(50_000), opts({ handle: null }))
    expect(r.text).toContain('could not be stored')
    expect(r.text).toContain('cannot be recovered')
    expect(r.text).not.toContain('read_tool_result')
    // It still names the remedy the model CAN act on.
    expect(r.text).toContain('narrower arguments')
  })

  it('keeps the notice when the budget is too small to hold any content', () => {
    // A view with no way back is worth less than no view: the handle survives
    // even when nothing else can.
    const r = buildCeilingView('q'.repeat(10_000), opts({ budgetBytes: 120 }))
    expect(r.text).toContain('tr_9f2c81a4b6d0e1f2')
    expect(r.applied).toBe(true)
  })

  it('never splits a multi-byte character', () => {
    // Cutting at a byte offset inside a UTF-8 sequence puts a replacement
    // character into the model's context, which is a corruption the model then
    // reports as data.
    const r = buildCeilingView('🙂'.repeat(20_000), opts({ budgetBytes: 1_000 }))
    expect(r.text).not.toContain('�')
  })
})
