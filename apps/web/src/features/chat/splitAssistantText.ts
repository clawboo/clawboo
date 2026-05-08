// splitAssistantText — splits an assistant message into a sequence of
// alternating prose / delegation segments, so the rendering pipeline can
// emit a markdown block for prose and a styled card for each
// `<delegate>` block.

import { findDelegationBlocks } from '@/features/group-chat/delegationDetector'

export type AssistantSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'delegation'; targetName: string; task: string }

/**
 * Walk the assistant text and produce an ordered list of segments. Empty
 * prose ranges between consecutive delegation blocks are dropped to keep
 * the rendered output clean (no blank markdown blobs between cards).
 */
export function splitAssistantText(text: string): AssistantSegment[] {
  if (!text) return []
  const blocks = findDelegationBlocks(text)
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
