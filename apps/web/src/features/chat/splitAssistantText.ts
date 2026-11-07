// splitAssistantText — splits an assistant message into a sequence of
// alternating prose / delegation segments, so the rendering pipeline can
// emit a markdown block for prose and a styled card for each
// `<delegate>` block.

import { findActionableHandOffs, findDelegationBlocks } from '@/features/group-chat/delegationTags'

export type AssistantSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'delegation'; targetName: string; task: string; blockStart: number; blockEnd: number }

/**
 * Walk the assistant text and produce an ordered list of segments. Empty
 * prose ranges between consecutive delegation blocks are dropped to keep
 * the rendered output clean (no blank markdown blobs between cards).
 *
 * `actionableOnly` is for a chat where a tag in code or a quote starts nothing: such a
 * tag stays in the prose, as written, and gets no card.
 */
export function splitAssistantText(
  text: string,
  opts?: { actionableOnly?: boolean },
): AssistantSegment[] {
  if (!text) return []
  const blocks = opts?.actionableOnly
    ? findActionableHandOffs(text).delegates
    : findDelegationBlocks(text)
  if (blocks.length === 0) {
    const trimmed = text.trim()
    return trimmed ? [{ kind: 'prose', text }] : []
  }

  const segments: AssistantSegment[] = []
  let cursor = 0
  for (const block of blocks) {
    // Emit any prose between the cursor and the block start.
    if (block.blockStart > cursor) {
      const prose = text.slice(cursor, block.blockStart)
      if (prose.trim().length > 0) {
        segments.push({ kind: 'prose', text: prose })
      }
    }
    // Strip the optional leading `@` from the resolved target so the UI
    // never double-renders it (the card prepends `@` itself).
    const cleanedName = block.targetName.replace(/^@/, '').trim()
    segments.push({
      kind: 'delegation',
      targetName: cleanedName,
      task: block.task,
      blockStart: block.blockStart,
      blockEnd: block.blockEnd,
    })
    cursor = block.blockEnd
  }
  // Tail prose after the last block.
  if (cursor < text.length) {
    const prose = text.slice(cursor)
    if (prose.trim().length > 0) {
      segments.push({ kind: 'prose', text: prose })
    }
  }
  return segments
}
