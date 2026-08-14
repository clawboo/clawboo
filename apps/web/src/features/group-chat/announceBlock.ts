// Deriving one spoken sentence per COMMITTED chat block, for the transcript's
// polite live region. Split out of GroupChatPanel so the truncation + "is this
// worth speaking" rules live in one testable place.
//
// Why not just mark the message list `aria-live`: the list interleaves in-flight
// stream cards whose text mutates on every SSE token, and blocks regroup as a
// turn accumulates thinking → tools → prose. A live region over that re-reads a
// growing sentence dozens of times per turn. Only committed blocks reach here.

import type { RenderBlock } from '@/features/chat/chatComponents'

import { stripDelegationBlocks, stripPlanBlocks } from './delegationTags'

const MAX_ANNOUNCE_CHARS = 180

function condense(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= MAX_ANNOUNCE_CHARS ? t : `${t.slice(0, MAX_ANNOUNCE_CHARS)}…`
}

/** Stable identity of a block, so a re-render that changed nothing about the
 *  timeline tail can't be mistaken for a new message arriving. */
export function blockKey(block: RenderBlock): string {
  if (block.kind === 'assistant-turn') {
    return (
      block.assistant?.entryId ??
      block.thinking[0]?.entryId ??
      block.tools[0]?.entryId ??
      `turn:${block.timestampMs ?? 0}`
    )
  }
  return block.entry.entryId
}

/** Millisecond timestamp of a block, or 0. Used to tell a live arrival from a
 *  history backfill. */
export function blockTimestamp(block: RenderBlock): number {
  return (block.kind === 'assistant-turn' ? block.timestampMs : block.entry.timestampMs) ?? 0
}

/**
 * One sentence for the live region, or `null` when the block isn't worth
 * speaking.
 *
 * @param nameFor  resolves an agent id to its display name.
 * @param agentIdOf  extracts the agent id from a session key.
 */
export function describeBlock(
  block: RenderBlock,
  nameFor: (agentId: string | null) => string,
  agentIdOf: (sessionKey: string) => string | null,
): string | null {
  if (block.kind === 'user') {
    const text = condense(block.entry.text)
    return text ? `You said: ${text}` : null
  }
  if (block.kind === 'meta') {
    const text = condense(block.entry.text)
    return text || null
  }
  // An assistant turn with no spoken prose is thinking / tool progress. Its text
  // commits as a later block, so staying quiet here is what stops ONE agent turn
  // from being announced two or three times as it lands piecewise.
  const raw = block.assistant?.text ?? ''
  const text = condense(stripPlanBlocks(stripDelegationBlocks(raw)))
  if (!text) return null
  const owner = block.assistant ? agentIdOf(block.assistant.sessionKey) : null
  return `${nameFor(owner)} said: ${text}`
}
