// MessageList — the bounded render window (#71).
//
// A session's transcript is capped at 500 entries and every block was rendered
// into the DOM on each streamed token. The list now renders only its tail, with
// a "Load earlier" control for the rest.
//
// jsdom has no layout, so `scrollHeight` / `scrollTop` / `clientHeight` are all
// 0: the hook's scroll-anchor restore is a no-op here and `atBottom` stays true,
// which keeps the window in plain tracking mode and the slicing deterministic.
// The pixel anchoring is only observable in a real browser — same limitation
// `JumpToLatestButton.test.tsx` documents for `useChatAutoScroll`.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'

import { MessageList, RENDER_WINDOW_INITIAL, RENDER_WINDOW_STEP } from '../chatComponents'
import type { RenderBlock } from '../chatComponents'

afterEach(cleanup)

// ── Fixtures ─────────────────────────────────────────────────────────────────

function userEntry(i: number): TranscriptEntry {
  return {
    entryId: `u${i}`,
    role: 'user',
    kind: 'user',
    text: `m${i}`,
    sessionKey: 'agent:a1:main',
    runId: null,
    source: 'local-send',
    timestampMs: 1_700_000_000_000 + i,
    sequenceKey: i,
    confirmed: true,
    fingerprint: `f${i}`,
  }
}

/** User blocks are the cheapest renderable block and their text is directly
 *  assertable. `MessageList` issues no fetches, so MSW's `onUnhandledRequest:
 *  'error'` stays satisfied without any handler. */
function userBlocks(count: number): RenderBlock[] {
  return Array.from({ length: count }, (_, i) => ({ kind: 'user', entry: userEntry(i) }))
}

/** Assistant turns close enough together that EVERY one is a follow-up of its
 *  predecessor — so the first visible block's margin proves whether the renderer
 *  used the absolute index or the sliced one. */
function followupTurns(count: number): RenderBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'assistant-turn' as const,
    assistant: {
      ...userEntry(i),
      entryId: `a${i}`,
      role: 'assistant' as const,
      kind: 'assistant' as const,
    },
    thinking: [],
    tools: [],
    // 1 s apart — well inside FOLLOWUP_WINDOW_MS (5 min).
    timestampMs: 1_700_000_000_000 + i * 1000,
    anchorEntryId: `a${i}`,
  }))
}

function renderList(blocks: RenderBlock[]) {
  return render(
    <MessageList
      blocks={blocks}
      streamingText={null}
      agentId="a1"
      agentName="Coder"
      isRunning={false}
      sessionKey="agent:a1:main"
    />,
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MessageList render window', () => {
  it('renders a short transcript whole, with no affordance', () => {
    renderList(userBlocks(RENDER_WINDOW_INITIAL - 1))
    expect(screen.queryByTestId('load-earlier')).toBeNull()
    expect(screen.getByText('m0')).toBeInTheDocument()
  })

  it('renders only the tail of a long transcript, and offers the rest', () => {
    const total = RENDER_WINDOW_INITIAL + 20
    renderList(userBlocks(total))

    // The 20 oldest are hidden; the window starts at m20.
    expect(screen.queryByText('m0')).toBeNull()
    expect(screen.queryByText('m19')).toBeNull()
    expect(screen.getByText('m20')).toBeInTheDocument()
    expect(screen.getByText(`m${total - 1}`)).toBeInTheDocument()
    expect(screen.getByTestId('load-earlier')).toHaveAttribute(
      'aria-label',
      'Load earlier messages (20 hidden)',
    )
  })

  it('reveals the hidden head when "Load earlier" is pressed', async () => {
    renderList(userBlocks(RENDER_WINDOW_INITIAL + 20))
    await userEvent.click(screen.getByTestId('load-earlier'))

    expect(screen.getByText('m0')).toBeInTheDocument()
    // One step (+100) more than covers the 20 hidden items, so nothing is left.
    expect(screen.queryByTestId('load-earlier')).toBeNull()
  })

  it('reveals exactly one step at a time when more remains hidden', async () => {
    const hidden = RENDER_WINDOW_STEP + 40
    renderList(userBlocks(RENDER_WINDOW_INITIAL + hidden))
    await userEvent.click(screen.getByTestId('load-earlier'))

    expect(screen.getByTestId('load-earlier')).toHaveAttribute(
      'aria-label',
      `Load earlier messages (${hidden - RENDER_WINDOW_STEP} hidden)`,
    )
  })

  // Author grouping and spacing must be computed from the ABSOLUTE index, so the
  // first VISIBLE block is grouped against the last HIDDEN one. If the renderer
  // used the sliced index, `blockMarginClass(0, …)` would return '' and the
  // follow-up would render as a new section.
  it('groups the first visible block against the last hidden one', () => {
    const { container } = renderList(followupTurns(RENDER_WINDOW_INITIAL + 20))
    const list = container.querySelector('[data-testid="chat-message-list"] > div')
    // Child 0 is the LoadEarlierButton wrapper; child 1 is the first visible turn.
    const firstVisible = list?.children[1]
    expect(firstVisible?.className).toContain('mt-2')
  })
})
