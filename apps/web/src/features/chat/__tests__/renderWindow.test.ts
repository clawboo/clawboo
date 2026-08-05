// The pure half of the bounded-timeline change: the window's index math and the
// stable turn anchor. Both are DOM-free, so they live in the node project — the
// hook's DOM behaviour is exercised through `MessageList` in the jsdom project,
// and the pixel-level scroll anchoring is only observable in a real browser
// (jsdom reports 0 for every scroll metric).

import { describe, it, expect } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'

import {
  groupEntriesToBlocks,
  renderWindowStart,
  RENDER_WINDOW_INITIAL,
  RENDER_WINDOW_STEP,
} from '@/features/chat/chatComponents'

describe('renderWindowStart', () => {
  it('renders everything when the list is shorter than the limit', () => {
    expect(renderWindowStart(10, 150, null)).toBe(0)
    expect(renderWindowStart(150, 150, null)).toBe(0)
  })

  it('renders the tail when the list is longer than the limit', () => {
    expect(renderWindowStart(170, 150, null)).toBe(20)
  })

  it('never returns a negative start', () => {
    expect(renderWindowStart(0, 150, null)).toBe(0)
    expect(renderWindowStart(0, 150, 40)).toBe(0)
  })

  it('honours a pinned start that holds the window open', () => {
    // Frozen at 20 while the user reads history; the list has since grown to 200,
    // whose natural start would be 50. The frozen value wins.
    expect(renderWindowStart(200, 150, 20)).toBe(20)
  })

  it('clamps a pinned start that is no longer reachable', () => {
    // The pin only ever holds the window OPEN — it can never narrow it below the
    // natural tail, so a stale larger pin collapses back.
    expect(renderWindowStart(170, 150, 90)).toBe(20)
  })

  // Nothing but an explicit pin can widen the window. A previous revision took a
  // `floor` so the team panel could keep a live stream mounted; because a floor
  // can only LOWER `start`, a long-running stream dragged it to 0 and mounted the
  // whole timeline with no user action. Callers hoist must-render items instead,
  // so the unpinned window is bounded by `limit` for any list size.
  it('bounds the unpinned window by `limit` at any scale', () => {
    for (const [total, limit] of [
      [400, 150],
      [5_000, 150],
      [50_000, 150],
      [5_000, 250],
    ] as const) {
      expect(total - renderWindowStart(total, limit, null)).toBeLessThanOrEqual(limit)
    }
  })

  // A pin CAN widen past `limit` — that is the user having pressed "Load
  // earlier", and honouring it is the point. Pinned to 3 renders from 3, not
  // from the natural tail.
  it('honours a user-driven pin even when it exceeds the limit', () => {
    expect(renderWindowStart(5_000, 150, 3)).toBe(3)
    expect(renderWindowStart(5_000, 150, 0)).toBe(0)
  })

  it('grows the window by exactly one step', () => {
    const total = RENDER_WINDOW_INITIAL + 200
    const before = renderWindowStart(total, RENDER_WINDOW_INITIAL, null)
    const after = renderWindowStart(total, RENDER_WINDOW_INITIAL + RENDER_WINDOW_STEP, null)
    expect(before - after).toBe(RENDER_WINDOW_STEP)
  })
})

// ── anchorEntryId ────────────────────────────────────────────────────────────

function entry(over: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    entryId: 'e1',
    role: 'assistant',
    kind: 'assistant',
    text: 'hello',
    sessionKey: 'agent:a1:main',
    runId: 'r1',
    source: 'runtime-chat',
    timestampMs: 1_700_000_000_000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
    ...over,
  }
}

describe('AssistantBlock.anchorEntryId', () => {
  it('is the first entry the turn absorbed, and does not move as the turn grows', () => {
    const thinking = entry({ entryId: 'think-1', kind: 'thinking', text: 'hmm' })
    const tool = entry({ entryId: 'tool-1', kind: 'tool', text: '[[tool]] ls' })
    const assistant = entry({ entryId: 'assistant-1', text: 'done' })

    // The same turn as it accumulates over the stream. If the key were derived at
    // render time from `assistant?.entryId ?? thinking[0]?.entryId`, it would flip
    // at the final step and remount the card exactly when the turn commits.
    const anchors = [[thinking], [thinking, tool], [thinking, tool, assistant]].map((entries) => {
      const block = groupEntriesToBlocks(entries)[0]
      return block?.kind === 'assistant-turn' ? block.anchorEntryId : null
    })

    expect(anchors).toEqual(['think-1', 'think-1', 'think-1'])
  })

  it('gives consecutive turns distinct anchors', () => {
    const blocks = groupEntriesToBlocks([
      entry({ entryId: 'a-1', text: 'first' }),
      entry({ entryId: 'a-2', text: 'second' }),
    ])
    const anchors = blocks.flatMap((b) => (b.kind === 'assistant-turn' ? [b.anchorEntryId] : []))
    expect(anchors).toEqual(['a-1', 'a-2'])
  })
})
