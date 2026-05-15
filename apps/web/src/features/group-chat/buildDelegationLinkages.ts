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
import { shouldDropAssistantTurn } from '@/lib/teamProtocol'
import { findDelegationBlocks, isRelayMessage } from './delegationDetector'
import { parseToolEntry } from '@/features/chat/parseToolEntry'
import type { ClawbooDispatch } from '@/stores/chat'
import type { RenderBlock } from '@/features/chat/chatComponents'

export interface DelegationLinkage {
  /** Stable id derived from source entry + block offset (or tool-entry id). */
  delegationId: string
  sourceEntryId: string
  sourceAgentId: string
  /**
   * Character offset of the `<delegate>` opener in the source entry's text
   * for explicit-tag linkages; for `sessions_send` tool-call linkages this
   * is the tool entry's `sequenceKey` (used only as a positional marker).
   */
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
  /**
   * `source` discriminates how the linkage was synthesized. The renderer
   * treats all four uniformly as DelegationCards but may render a small
   * badge for the non-canonical paths so the user knows what was routed
   * vs. what the LLM emitted explicitly:
   *
   *   - `delegate-tag` — structured `<delegate>` block in the leader's
   *     prose (the canonical Clawboo flow).
   *   - `sessions-send` — Round 6: the LLM called OpenClaw's `sessions_send`
   *     Gateway tool; the tool entry IS visible in `block.tools[]`.
   *   - `clawboo-dispatch` — Round 7: Clawboo's own commit-time delegation
   *     detector caught a fallback regex match (`@Name` patterns) and fired
   *     `chat.send`. No `<delegate>` tag in the prose to render via Path 1.
   *   - `clawboo-relay` — Round 7: Clawboo's `flushRelayBatch` forwarded
   *     the leader's response to a teammate as a `[Team Update]` envelope.
   *     The leader didn't intend a delegation; Clawboo's routing is what
   *     produced the wake.
   */
  source: 'delegate-tag' | 'sessions-send' | 'clawboo-dispatch' | 'clawboo-relay'
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
  /**
   * Round 7: Clawboo's recorded outgoing routing events for this team,
   * keyed by `${teamId}:${sourceEntryId}`. Threaded in from `GroupChatPanel`
   * via `useChatStore(s => s.clawbooDispatches)`. Path 3 in the linkage
   * scan consumes this map so DelegationCards reflect actual Clawboo
   * orchestration even when the LLM never emits `<delegate>` /
   * `sessions_send`. When omitted (1:1 chat path), Path 3 is skipped.
   */
  clawbooDispatches?: Map<string, ClawbooDispatch[]>
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
 * Pull the structured params out of a `sessions_send` tool-call body. The
 * Gateway emits the body as a fenced JSON block via `formatToolCallMarkdown`
 * in `@clawboo/protocol`. OpenClaw's actual schema (verified against
 * `openclaw/dist/.../createSessionsSendTool` at line 88732):
 *
 *   ```json
 *   {
 *     "sessionKey": "agent:<id>:<sessionName>",  // optional
 *     "label": "Engineer Boo",                    // optional, max 64 chars
 *     "agentId": "engineer-boo",                  // optional, max 64 chars
 *     "message": "do this task"                   // REQUIRED
 *   }
 *   ```
 *
 * The caller must provide at least one of (sessionKey | label | agentId).
 * We return whichever fields are present and let the linkage builder resolve
 * them against the participant roster in order: sessionKey > agentId > label.
 *
 * Parsing is defensive — malformed JSON / wrong shape yields `null`, the
 * linkage is skipped, and the raw tool entry keeps rendering as a
 * `ToolCallCard`.
 *
 * NOTE: Round 6 originally looked for `to` but `sessions_send` has NEVER
 * had a `to` field; that was a wrong assumption from the plan. The fix is
 * here.
 */
export interface SessionsSendParams {
  /** `agent:<id>:<sessionName>` format, when the caller used a direct key. */
  sessionKey?: string
  /** Human-readable label — typically the agent's `name`. Max 64 chars. */
  label?: string
  /** Direct agent id when present. Max 64 chars. */
  agentId?: string
  /** Required body. */
  message: string
}

export function extractSessionsSendParams(body: string): SessionsSendParams | null {
  if (!body) return null
  // Strip ```json ... ``` fences (and the alternative bare ``` ... ```).
  let inner = body.trim()
  const fenceMatch = inner.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  if (fenceMatch) inner = fenceMatch[1]!.trim()
  if (!inner) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(inner)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const messageRaw = obj['message']
  if (typeof messageRaw !== 'string') return null
  const message = messageRaw.trim()
  if (!message) return null

  const result: SessionsSendParams = { message }
  const sessionKey = typeof obj['sessionKey'] === 'string' ? obj['sessionKey'].trim() : ''
  const label = typeof obj['label'] === 'string' ? obj['label'].trim() : ''
  const agentId = typeof obj['agentId'] === 'string' ? obj['agentId'].trim() : ''
  if (sessionKey) result.sessionKey = sessionKey
  if (label) result.label = label
  if (agentId) result.agentId = agentId

  // Need at least one routing identifier to be useful.
  if (!result.sessionKey && !result.label && !result.agentId) return null
  return result
}

/**
 * Resolve a `sessions_send` target against the team roster. Tries in
 * priority order:
 *   1. `sessionKey` — parse `agent:<id>:<sessionName>` and look up by id.
 *   2. `agentId` — direct id match.
 *   3. `label` — case-insensitive name match against participants.
 * Returns the resolved participant or null.
 */
export function resolveSessionsSendTarget(
  params: SessionsSendParams,
  participants: { id: string; name: string }[],
): { id: string; name: string } | null {
  if (params.sessionKey) {
    const match = params.sessionKey.match(/^agent:([^:]+):/)
    const id = match?.[1]
    if (id) {
      const hit = participants.find((p) => p.id === id)
      if (hit) return hit
    }
  }
  if (params.agentId) {
    const hit = participants.find((p) => p.id === params.agentId)
    if (hit) return hit
  }
  if (params.label) {
    const lower = params.label.toLowerCase()
    const exact = participants.find((p) => p.name.toLowerCase() === lower)
    if (exact) return exact
    // Tolerate leading `@` and longest-prefix.
    const stripped = params.label.replace(/^@/, '').trim().toLowerCase()
    const sorted = [...participants].sort((a, b) => b.name.length - a.name.length)
    for (const p of sorted) {
      if (stripped === p.name.toLowerCase()) return p
    }
    for (const p of sorted) {
      const lp = p.name.toLowerCase()
      if (stripped.startsWith(lp) || lp.startsWith(stripped)) return p
    }
  }
  return null
}

/**
 * Shared target-response accrual used by ALL three scanner paths (explicit
 * `<delegate>`, Round 6 `sessions_send` tool calls, Round 7 Clawboo
 * dispatches). Finds the earliest unclaimed assistant entry from the
 * target whose `timestampMs` is strictly greater than the source's anchor,
 * then accretes every following entry in the target's bucket that shares
 * the same `runId` (thinking, tool, assistant chunks all belong to one
 * reply). Mutates `claimedEntries`.
 *
 * IMPORTANT — why timestamp, not sequenceKey:
 *
 * `sequenceKey` is process-local (`lib/sequenceKey.ts` resets to 0 on each
 * page reload), while transcript data PERSISTS across sessions in SQLite.
 * After a reload, hydrated entries from prior sessions keep their original
 * sequenceKeys — which can be HIGHER than newly-emitted entries in the
 * current session. A pure-sequenceKey filter (used pre-Round 7B) caused
 * the linkage scan to claim STALE responses from earlier conversations
 * instead of the fresh ones triggered by the current source. Symptom in
 * production: DelegationCards rendered with the target agent's old intro
 * ("Hey! I'm @X, and I specialize in...") nested inside while the fresh
 * substantive response landed at top level below, unattached.
 *
 * The fix: filter by `timestampMs > source.timestampMs` (with a small
 * tolerance to break ms-collision ties via sequenceKey). Timestamps are
 * wall-clock and stable across reloads — a fresh response committed AFTER
 * the source's timestamp is genuinely "after" regardless of seqkey state.
 *
 * Returns linked entries in chronological order (defensively sorted).
 */
function findTargetResponse(params: {
  bucket: TranscriptEntry[]
  /** Timestamp of the source anchor — the primary "after-source" filter. */
  sourceTimestampMs: number
  /** sequenceKey of the source — used only as a same-millisecond tiebreaker. */
  sourceSequenceKey: number
  claimedEntries: Set<string>
}): TranscriptEntry[] {
  const { bucket, sourceTimestampMs, sourceSequenceKey, claimedEntries } = params

  /** A candidate is "after the source" when its timestamp is strictly later,
   *  OR same-ms-but-later-seqkey (rare; defensive tiebreaker). */
  const isAfterSource = (candidate: TranscriptEntry): boolean => {
    const candTs = candidate.timestampMs ?? 0
    if (candTs > sourceTimestampMs) return true
    if (candTs === sourceTimestampMs) return candidate.sequenceKey > sourceSequenceKey
    return false
  }

  let firstReply: TranscriptEntry | null = null
  for (const candidate of bucket) {
    if (candidate.role !== 'assistant' || candidate.kind !== 'assistant') continue
    if (!isAfterSource(candidate)) continue
    if (claimedEntries.has(candidate.entryId)) continue
    firstReply = candidate
    break
  }
  const linkedEntries: TranscriptEntry[] = []
  if (!firstReply) return linkedEntries
  const runId = firstReply.runId
  for (const candidate of bucket) {
    if (candidate.entryId === firstReply.entryId) {
      linkedEntries.push(candidate)
      claimedEntries.add(candidate.entryId)
      continue
    }
    if (runId === null) continue
    if (candidate.runId !== runId) continue
    if (claimedEntries.has(candidate.entryId)) continue
    if (!isAfterSource(candidate)) continue
    linkedEntries.push(candidate)
    claimedEntries.add(candidate.entryId)
  }
  linkedEntries.sort((a, b) => {
    const ts = (a.timestampMs ?? 0) - (b.timestampMs ?? 0)
    if (ts !== 0) return ts
    return a.sequenceKey - b.sequenceKey
  })
  return linkedEntries
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
  const { blocks, mergedEntries, teamId, participants, clawbooDispatches } = params

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
    // Broken-shape turns are never a source of delegations: OpenClaw
    // protocol control tokens (ANNOUNCE_SKIP, NO_REPLY, NO), Clawboo
    // tokens (__resumed__, __skipped__), and short refusal leaks. Same
    // gate as the chat renderer in `chatComponents.groupEntriesToBlocks`.
    if (shouldDropAssistantTurn(text)) continue

    const sourceAgentId = agentIdFromSessionKey(sourceEntry.sessionKey)
    if (!sourceAgentId) continue

    const recordLinkage = (linkage: DelegationLinkage): void => {
      linkagesByDelegationId.set(linkage.delegationId, linkage)
      const bySource = linkagesBySourceEntry.get(sourceEntry.entryId)
      if (bySource) bySource.push(linkage)
      else linkagesBySourceEntry.set(sourceEntry.entryId, [linkage])
      // First pending delegation per target sessionKey owns the streaming
      // card — later pending delegations to the same target wait their turn.
      if (linkage.isPending && !streamingOwnerByTargetSessionKey.has(linkage.targetSessionKey)) {
        streamingOwnerByTargetSessionKey.set(linkage.targetSessionKey, linkage.delegationId)
      }
    }

    // ─── Path 1: structured `<delegate>` tags (the canonical Clawboo flow) ──
    const delegateBlocks = findDelegationBlocks(text)
    for (const delegateBlock of delegateBlocks) {
      if (!delegateBlock.task) continue
      const target = resolveTarget(delegateBlock.targetName, participants)
      if (!target) continue
      if (target.id === sourceAgentId) continue

      const targetSessionKey = buildTeamSessionKey(target.id, teamId)
      const targetBucket = entriesByAgent.get(target.id) ?? []
      const linkedEntries = findTargetResponse({
        bucket: targetBucket,
        sourceTimestampMs: sourceEntry.timestampMs ?? 0,
        sourceSequenceKey: sourceEntry.sequenceKey,
        claimedEntries,
      })

      recordLinkage({
        delegationId: `${sourceEntry.entryId}:${delegateBlock.blockStart}`,
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
        source: 'delegate-tag',
      })
    }

    // ─── Path 2: Round 6 — OpenClaw `sessions_send` tool calls ──────────────
    // The LLM often skips structured `<delegate>` tags and uses OpenClaw's
    // built-in `sessions_send` Gateway tool instead. That tool call IS
    // visible in the source's tool entries (`block.tools[]`), so we can
    // render the actual routing as a DelegationCard with the EXACT task
    // body from the JSON params — no prose heuristics, no time-window
    // guessing. Each tool entry whose name starts with `sessions_send`
    // becomes a structured linkage; the raw `[[tool]]` markdown stops
    // rendering (claimed) and the DelegationCard takes its place.
    //
    // Schema (verified against the installed `openclaw` package's
    // `SessionsSendToolSchema` at line 88732 of its bundle):
    //   { sessionKey?, label?, agentId?, message }
    // The caller supplies at least one routing identifier. We try each in
    // priority order via `resolveSessionsSendTarget`.
    for (const toolEntry of block.tools) {
      const parsed = parseToolEntry(toolEntry.text)
      if (!parsed || parsed.kind !== 'call') continue
      // Tool name is "<name>" or "<name> (<call_id>)" — match prefix.
      const namePrefix = parsed.name.split(/[\s(]/)[0]?.trim() ?? ''
      if (namePrefix !== 'sessions_send') continue

      const params = extractSessionsSendParams(parsed.body)
      if (!params) continue

      const target = resolveSessionsSendTarget(params, participants)
      if (!target) continue
      if (target.id === sourceAgentId) continue

      const targetSessionKey = buildTeamSessionKey(target.id, teamId)
      const targetBucket = entriesByAgent.get(target.id) ?? []
      const linkedEntries = findTargetResponse({
        bucket: targetBucket,
        // Anchor on the tool entry's timestamp — the tool call happens
        // mid-stream, so the target's response should follow it in
        // wall-clock time (sequenceKey alone fails after page reload —
        // see `findTargetResponse` docs).
        sourceTimestampMs: toolEntry.timestampMs ?? sourceEntry.timestampMs ?? 0,
        sourceSequenceKey: toolEntry.sequenceKey,
        claimedEntries,
      })

      // Claim the tool entry itself so `AssistantTurnCard` doesn't ALSO
      // render the raw `[[tool]] sessions_send …` line — the DelegationCard
      // is its visual replacement.
      claimedEntries.add(toolEntry.entryId)

      recordLinkage({
        delegationId: `${sourceEntry.entryId}:sessions-send:${toolEntry.entryId}`,
        sourceEntryId: sourceEntry.entryId,
        sourceAgentId,
        blockStart: toolEntry.sequenceKey,
        targetAgentId: target.id,
        targetAgentName: target.name,
        targetRawName: target.name,
        task: params.message,
        targetSessionKey,
        linkedEntries,
        isPending: linkedEntries.length === 0,
        source: 'sessions-send',
      })
    }

    // ─── Path 3: Round 7 — Clawboo's own routing events ────────────────────
    // When the LLM doesn't emit `<delegate>` tags OR `sessions_send` calls
    // BUT Clawboo's orchestration STILL routed work to specialists (via the
    // fallback regex in `detectDelegations` or via `flushRelayBatch`),
    // those events live in `clawbooDispatches`. Render them as
    // DelegationCards so the user sees actual Clawboo routing, not whatever
    // the LLM happened to emit in prose.
    //
    // Dedup: skip when Path 1 or Path 2 already linked the same target for
    // this source entry. The LLM's explicit signal (or its tool call) wins
    // over our recorded routing event. Same-source same-target → keep the
    // earlier linkage.
    if (clawbooDispatches) {
      const dispatchKey = `${teamId}:${sourceEntry.entryId}`
      const dispatches = clawbooDispatches.get(dispatchKey) ?? []
      for (const dispatch of dispatches) {
        const existingForTarget = (linkagesBySourceEntry.get(sourceEntry.entryId) ?? []).find(
          (l) => l.targetAgentId === dispatch.targetAgentId,
        )
        if (existingForTarget) continue

        const target = participants.find((p) => p.id === dispatch.targetAgentId)
        if (!target) continue
        if (target.id === sourceAgentId) continue

        const targetSessionKey = buildTeamSessionKey(dispatch.targetAgentId, teamId)
        const targetBucket = entriesByAgent.get(target.id) ?? []
        const linkedEntries = findTargetResponse({
          bucket: targetBucket,
          sourceTimestampMs: dispatch.timestampMs,
          sourceSequenceKey: dispatch.sequenceKey,
          claimedEntries,
        })

        recordLinkage({
          delegationId: dispatch.dispatchId,
          sourceEntryId: sourceEntry.entryId,
          sourceAgentId: dispatch.sourceAgentId,
          blockStart: dispatch.sequenceKey,
          targetAgentId: dispatch.targetAgentId,
          targetAgentName: dispatch.targetAgentName,
          targetRawName: dispatch.targetAgentName,
          task: dispatch.taskBody,
          targetSessionKey,
          linkedEntries,
          isPending: linkedEntries.length === 0,
          source: dispatch.origin === 'dispatch-delegation' ? 'clawboo-dispatch' : 'clawboo-relay',
        })
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
