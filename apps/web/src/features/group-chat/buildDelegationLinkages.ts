// buildDelegationLinkages — pure helper that pairs each `<delegate>` block
// inside a source agent's response with the next eligible target response in
// the merged team transcript. The renderer (`GroupChatPanel`) feeds the result
// into `AssistantTurnCard`/`DelegationCard` so target replies render nested
// inside the source's delegation card instead of as separate top-level cards.
//
// Why renderer-only: the Gateway's `chat.send` does not echo a runId, and the
// team-chat-override pending slot is single-valued, so racing user-@ and
// delegation sends to the same target cannot be cleanly disambiguated at
// send time anyway. A pure renderer scan has the same attribution behaviour
// with a fraction of the moving parts (no Zustand store, no hydrate hook,
// no freeze-window interaction).

import type { TranscriptEntry } from '@clawboo/protocol'
import { agentIdFromSessionKey, buildTeamSessionKey } from '@/lib/sessionUtils'
import { findDelegationBlocks, isRelayMessage } from './delegationDetector'
import type { RenderBlock } from '@/features/chat/chatComponents'

export interface DelegationLinkage {
  /** Stable id derived from source entry + block offset. */
  delegationId: string
  sourceEntryId: string
  sourceAgentId: string
  /** Character offset of the `<delegate>` opener in the source entry's text. */
  blockStart: number
  /** Resolved id of the target agent (after team-roster lookup). */
  targetAgentId: string
  /** Resolved roster name of the target agent. */
  targetAgentName: string
  /** Raw `to="..."` attribute value as written by the LLM (post `@` strip). */
  targetRawName: string
  task: string
  /** Team-scoped sessionKey for the target. */
  targetSessionKey: string
  /** All transcript entries claimed by this delegation, in chronological order. */
  linkedEntries: TranscriptEntry[]
  /** True when the target hasn't yet committed any reply for this delegation. */
  isPending: boolean
}

export interface BuildDelegationLinkagesResult {
  /** Lookup by `delegationId`. */
  linkagesByDelegationId: Map<string, DelegationLinkage>
  /** Lookup by source entry id — returns delegations in source-text order. */
  linkagesBySourceEntry: Map<string, DelegationLinkage[]>
  /** Union of every entryId claimed by some delegation. */
  claimedEntries: Set<string>
  /**
   * Target sessionKeys for which the latest unclaimed delegation hasn't
   * received a reply yet. The renderer filters streaming cards for these
   * sessions so the live stream surfaces inside the DelegationCard instead.
   * Maps sessionKey → the delegationId that "owns" that stream.
   */
  streamingOwnerByTargetSessionKey: Map<string, string>
}

export interface BuildDelegationLinkagesParams {
  blocks: RenderBlock[]
  mergedEntries: TranscriptEntry[]
  teamId: string
  /**
   * Effective participants for the team — DB members + Boo Zero. Used for
   * `to="..."` resolution and to ignore self-delegations.
   */
  participants: { id: string; name: string }[]
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function resolveTarget(
  raw: string,
  participants: { id: string; name: string }[],
): { id: string; name: string } | null {
  const stripped = raw.replace(/^@/, '').trim().toLowerCase()
  if (!stripped) return null
  const sorted = [...participants].sort((a, b) => b.name.length - a.name.length)
  for (const agent of sorted) {
    if (stripped === agent.name.toLowerCase()) return agent
  }
  for (const agent of sorted) {
    const lower = agent.name.toLowerCase()
    if (stripped.startsWith(lower) || lower.startsWith(stripped)) return agent
  }
  return null
}

/**
 * Bucket `mergedEntries` by owning agent id (derived from sessionKey).
 * Returns one ordered list per agent so claim lookups don't re-scan the
 * full transcript for each delegation.
 */
function bucketByAgent(mergedEntries: TranscriptEntry[]): Map<string, TranscriptEntry[]> {
  const buckets = new Map<string, TranscriptEntry[]>()
  for (const entry of mergedEntries) {
    const agentId = agentIdFromSessionKey(entry.sessionKey)
    if (!agentId) continue
    let bucket = buckets.get(agentId)
    if (!bucket) {
      bucket = []
      buckets.set(agentId, bucket)
    }
    bucket.push(entry)
  }
  return buckets
}

// ─── Main ──────────────────────────────────────────────────────────────────

export function buildDelegationLinkages(
  params: BuildDelegationLinkagesParams,
): BuildDelegationLinkagesResult {
  const { blocks, mergedEntries, teamId, participants } = params

  const linkagesByDelegationId = new Map<string, DelegationLinkage>()
  const linkagesBySourceEntry = new Map<string, DelegationLinkage[]>()
  const claimedEntries = new Set<string>()
  const streamingOwnerByTargetSessionKey = new Map<string, string>()

  if (blocks.length === 0 || mergedEntries.length === 0) {
    return {
      linkagesByDelegationId,
      linkagesBySourceEntry,
      claimedEntries,
      streamingOwnerByTargetSessionKey,
    }
  }

  const entriesByAgent = bucketByAgent(mergedEntries)

  for (const block of blocks) {
    if (block.kind !== 'assistant-turn') continue
    const sourceEntry = block.assistant
    if (!sourceEntry) continue
    const text = sourceEntry.text
    if (!text) continue
    // Relays carry condensed summaries that may incidentally contain
    // delegate-looking strings — guard against false positives.
    if (isRelayMessage(text)) continue

    const sourceAgentId = agentIdFromSessionKey(sourceEntry.sessionKey)
    if (!sourceAgentId) continue

    const delegateBlocks = findDelegationBlocks(text)
    if (delegateBlocks.length === 0) continue

    for (const delegateBlock of delegateBlocks) {
      if (!delegateBlock.task) continue
      const target = resolveTarget(delegateBlock.targetName, participants)
      if (!target) continue
      // Self-delegation: not a real routing intent.
      if (target.id === sourceAgentId) continue

      const delegationId = `${sourceEntry.entryId}:${delegateBlock.blockStart}`
      const targetSessionKey = buildTeamSessionKey(target.id, teamId)
      const targetBucket = entriesByAgent.get(target.id) ?? []

      // Find the earliest unclaimed assistant entry from the target whose
      // sequenceKey is strictly greater than the source's. sequenceKey is the
      // process-local monotonic counter — it breaks millisecond-collision
      // ties that timestampMs alone can't.
      let firstReply: TranscriptEntry | null = null
      for (const candidate of targetBucket) {
        if (candidate.role !== 'assistant' || candidate.kind !== 'assistant') continue
        if (candidate.sequenceKey <= sourceEntry.sequenceKey) continue
        if (claimedEntries.has(candidate.entryId)) continue
        firstReply = candidate
        break
      }

      const linkedEntries: TranscriptEntry[] = []
      if (firstReply) {
        const runId = firstReply.runId
        // Accrete every entry in the target bucket sharing the same runId
        // — thinking, tool, assistant chunks all belong to one reply.
        for (const candidate of targetBucket) {
          if (candidate.entryId === firstReply.entryId) {
            linkedEntries.push(candidate)
            claimedEntries.add(candidate.entryId)
            continue
          }
          if (runId === null) continue
          if (candidate.runId !== runId) continue
          if (claimedEntries.has(candidate.entryId)) continue
          // Don't pull in entries that came BEFORE the first claimed reply —
          // a previous run could legitimately share `null` runId in rare
          // cases, but a non-null runId match plus sequenceKey ordering keeps
          // us safe here.
          if (candidate.sequenceKey <= sourceEntry.sequenceKey) continue
          linkedEntries.push(candidate)
          claimedEntries.add(candidate.entryId)
        }
        // Keep linkedEntries chronological (mergedEntries is already sorted,
        // so the bucket is too — but `firstReply` was pushed first above,
        // which may not be the chronologically earliest. Re-sort defensively.)
        linkedEntries.sort((a, b) => {
          const ts = (a.timestampMs ?? 0) - (b.timestampMs ?? 0)
          if (ts !== 0) return ts
          return a.sequenceKey - b.sequenceKey
        })
      }

      const linkage: DelegationLinkage = {
        delegationId,
        sourceEntryId: sourceEntry.entryId,
        sourceAgentId,
        blockStart: delegateBlock.blockStart,
        targetAgentId: target.id,
        targetAgentName: target.name,
        targetRawName: delegateBlock.targetName.replace(/^@/, '').trim(),
        task: delegateBlock.task,
        targetSessionKey,
        linkedEntries,
        isPending: linkedEntries.length === 0,
      }

      linkagesByDelegationId.set(delegationId, linkage)
      const bySource = linkagesBySourceEntry.get(sourceEntry.entryId)
      if (bySource) {
        bySource.push(linkage)
      } else {
        linkagesBySourceEntry.set(sourceEntry.entryId, [linkage])
      }

      // First pending delegation per target sessionKey owns the streaming
      // card — later pending delegations to the same target wait their turn.
      if (linkage.isPending && !streamingOwnerByTargetSessionKey.has(targetSessionKey)) {
        streamingOwnerByTargetSessionKey.set(targetSessionKey, delegationId)
      }
    }
  }

  return {
    linkagesByDelegationId,
    linkagesBySourceEntry,
    claimedEntries,
    streamingOwnerByTargetSessionKey,
  }
}
