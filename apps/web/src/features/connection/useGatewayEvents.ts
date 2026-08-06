import { useEffect } from 'react'
import type { GatewayClient } from '@clawboo/gateway-client'
import type { AgentStatusPatch, ChatCost } from '@clawboo/events'
import { createEventHandler, createPatchQueue, processEvent } from '@clawboo/events'
import type { TranscriptEntry } from '@clawboo/protocol'
import { isTeamSessionKey } from '@clawboo/team-orchestration'
import { listAgentSessions } from '@clawboo/control-client'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalsStore, type ApprovalRequest } from '@/stores/approvals'
import { parseApprovalRequestPayload } from '@/features/approvals/useApprovalActions'
import { nextSeq } from '@/lib/sequenceKey'
import { refreshFleetFromRegistry } from '@/lib/agentSourceClient'
import { nextMirroredStatus } from './socketStatusMirror'

// ─── useGatewayEvents ─────────────────────────────────────────────────────────
//
// Wires a live GatewayClient into the Bridge → Policy → Handler pipeline, and
// mirrors the live socket's status into the connection store.
// Call this hook once at the top of the app; it is a no-op when client is null.

/** Chars-per-token, matching the estimate the Policy layer uses for output. */
const CHARS_PER_TOKEN = 4

/**
 * Bill one committed turn. Called from the `commitChat` dispatch, so it sits
 * BEHIND the Handler's closed-run guard: a replayed `chat:final` never reaches
 * it. (This used to be a second `client.onEvent` subscription that re-parsed
 * every raw frame itself — outside the pipeline, and therefore outside the
 * guard, so a replay was billed twice.)
 *
 * Runs BEFORE the pending-approval early-return below on purpose: the tokens
 * were spent whether or not the status patch is applied.
 */
export function recordChatCost(agentId: string, runId: string | null, cost: ChatCost): void {
  let inputTokens = cost.inputTokens ?? 0

  // `null` input means the Gateway sent no usage block — estimate the prompt
  // from the agent's last user message (a store read, which is why the pure
  // Policy layer leaves it to us).
  if (cost.inputTokens === null) {
    const mainKey = useFleetStore.getState().agents.find((a) => a.id === agentId)?.sessionKey
    const transcript = useChatStore.getState().transcripts.get(mainKey ?? '')
    if (transcript) {
      for (let i = transcript.length - 1; i >= 0; i--) {
        if (transcript[i]!.kind === 'user') {
          inputTokens = Math.ceil(transcript[i]!.text.length / CHARS_PER_TOKEN)
          break
        }
      }
    }
  }

  if (inputTokens === 0 && cost.outputTokens === 0) return

  // Real counts for the chat UI's per-turn footer.
  if (runId) {
    useChatStore.getState().setLastTokenUsage(runId, inputTokens, cost.outputTokens)
  }

  void fetch('/api/cost-records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      model: cost.model,
      inputTokens,
      outputTokens: cost.outputTokens,
      runId,
    }),
  }).catch(() => {
    // best-effort — never throw in event handlers
  })
}

export function useGatewayEvents(client: GatewayClient | null): void {
  // ── Live socket status → connection store ────────────────────────────────
  //
  // Deliberately its OWN effect rather than a few lines inside the pipeline
  // effect below. `client.onStatus(h)` invokes `h` synchronously at subscribe
  // time (it replays the current status), so a throw from this handler inside
  // the pipeline effect would abort that effect part-way: no event
  // subscriptions, no approval-expiry interval, and — worst — no cleanup
  // registered, permanently leaking the patch queue and handler. Same `[client]`
  // dep, so the lifetime is identical; the blast radius is not.
  //
  // Per-client subscription, so native mode (client === null) never arms it.
  useEffect(() => {
    if (!client) return

    const unsubStatus = client.onStatus((socketStatus) => {
      // NOTHING may throw out of here. The client fans handlers out bare from
      // `updateStatus`, and its 'connected' emission happens inside
      // `sendConnect()`'s try — a throw there is misread as a connect failure
      // (device token cleared, socket closed 4008, infinite retry).
      try {
        const conn = useConnectionStore.getState()
        // A superseded client must never stomp its replacement: every connect
        // flow disconnects the previous client, and that teardown emits.
        if (conn.client !== client) return
        const next = nextMirroredStatus(socketStatus, conn.status)
        if (next) conn.setStatus(next)
      } catch {
        // Best-effort mirror — a broken status write must not break the socket.
      }
    })

    return () => {
      unsubStatus()
    }
  }, [client])

  useEffect(() => {
    if (!client) return

    // ── RAF-batched patch queue → fleet store ──────────────────────────────
    const patchQueue = createPatchQueue((patches) => {
      for (const { agentId, updates } of patches) {
        useFleetStore.getState().patchAgent(agentId, updates as AgentStatusPatch)
      }
    })

    // ── Event handler with all deps wired to Zustand stores ────────────────
    const handler = createEventHandler({
      // State queries
      getAgentRunId: (agentId) =>
        useFleetStore.getState().agents.find((a) => a.id === agentId)?.runId ?? null,

      // Intent dispatcher — handles terminal intents that need Zustand writes
      dispatchIntent: (intent) => {
        switch (intent.kind) {
          case 'updateAgentStatus': {
            // Don't mark agent idle while an exec approval is pending — the agent
            // run is still alive, blocked on the approval decision. The Gateway
            // sends a chat final event when the LLM response stream ends, but the
            // tool execution (and therefore the full run) continues after approval.
            const pendingApprovals = useApprovalsStore.getState().pendingApprovals
            const hasPending = Array.from(pendingApprovals.values()).some(
              (a) => a.agentId === intent.agentId,
            )
            if (hasPending && intent.patch.status !== 'running') {
              // Keep the agent as 'running' — the approval resolution will
              // eventually produce a real final event that sets it idle.
              useFleetStore.getState().updateLastSeen(intent.agentId, Date.now())
              break
            }
            useFleetStore.getState().patchAgent(intent.agentId, intent.patch)
            useFleetStore.getState().updateLastSeen(intent.agentId, Date.now())
            break
          }
          case 'commitChat': {
            // Bill the turn first — the tokens were spent regardless of whether
            // the status patch below is applied or deferred by an approval.
            if (intent.cost) recordChatCost(intent.agentId, intent.runId, intent.cost)
            // Don't commit the chat final (idle/error) while an exec approval is
            // pending — the run is still alive waiting for the approval decision.
            const commitPending = useApprovalsStore.getState().pendingApprovals
            const commitHasPending = Array.from(commitPending.values()).some(
              (a) => a.agentId === intent.agentId,
            )
            if (commitHasPending) {
              // Still append output lines, but skip the status patch.
              useFleetStore.getState().updateLastSeen(intent.agentId, Date.now())
              break
            }
            // outputLines already handled by appendOutputLines above;
            // apply the final status patch (idle/error, runId cleared)
            useFleetStore.getState().patchAgent(intent.agentId, intent.patch)
            useFleetStore.getState().updateLastSeen(intent.agentId, Date.now())
            // Clear the session's streaming text in the chat store — except team
            // sessions, whose streaming text is owned by the team-chat SSE (a
            // clear here would wipe the SSE's live stream). See appendOutputLines.
            if (intent.sessionKey && !isTeamSessionKey(intent.sessionKey)) {
              useChatStore.getState().setStreamingText(intent.sessionKey, null)
            }
            break
          }
          // approval intents: trust plane
          case 'approvalPending': {
            const request = parseApprovalRequestPayload(intent.payload)
            if (request) {
              useApprovalsStore.getState().addPending(request)
            }
            break
          }
          case 'approvalResolved': {
            const p = intent.payload as Record<string, unknown> | null
            const resolvedId = typeof p?.['id'] === 'string' ? p['id'] : null
            if (resolvedId) {
              useApprovalsStore.getState().removePending(resolvedId)
            }
            break
          }
          default:
            break
        }
      },

      // Live patch queue (streaming — RAF-batched)
      queueLivePatch: (agentId, patch, sessionKey?) => {
        patchQueue.enqueue({ agentId, updates: patch })
        // Sync streaming text to the chat store for this session — EXCEPT team
        // sessions, whose live tokens arrive over the server team-chat SSE
        // (useTeamChatStream applyDeltaFrame). The fleet-status patch above still
        // applies (the agent's running indicator). See appendOutputLines.
        if (sessionKey && !isTeamSessionKey(sessionKey) && patch.streamText !== undefined) {
          useChatStore.getState().setStreamingText(sessionKey, patch.streamText)
          // Anchor the stream-start timestamp for this session in the chat
          // store. First chunk wins (the store action is no-op when already
          // set). Skipped when `streamText` is null (end-of-stream marker)
          // so we don't re-anchor right before commit. The renderer reads
          // this timestamp to position the live StreamingCard at its
          // chronological slot — no more "bottom-of-list during stream,
          // jump to top on commit" re-arrangement.
          if (patch.streamText !== null) {
            useChatStore.getState().setStreamStart(sessionKey, Date.now())
          }
        }
      },

      // Flush all pending patches for an agent immediately
      clearPendingLivePatch: (_agentId) => {
        patchQueue.flush()
      },

      // Append committed output lines to the chat transcript
      appendOutputLines: (agentId, lines, eventSessionKey?) => {
        if (lines.length === 0) return
        const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
        const sessionKey = eventSessionKey ?? agent?.sessionKey
        if (!sessionKey) return

        // Team sessions are owned by the SERVER orchestrator: it persists each
        // turn (persistTeamChatEntry) and streams it back over the team-chat SSE
        // (useTeamChatStream). The browser's Gateway connection ALSO sees these
        // broadcast frames — committing + POSTing them here would double-write the
        // turn (a distinct entryId per Gateway final-frame, so the store-level
        // dedup misses cross-source / cross-second copies). Skip: the SSE is the
        // sole source of team chat. 1:1 sessions still commit normally.
        //
        // LOAD-BEARING: `stores/chat.ts` no longer backstops this. Its layer-2
        // dedup was narrowed to exact-frame identity (#71) precisely because the
        // timestamp-independent team rule it used to carry was collapsing genuine
        // re-utterances. Reintroducing a browser-side write into a team session
        // would make the cross-writer duplicate visible again.
        if (isTeamSessionKey(sessionKey)) return

        // Anchor the commit batch to when streaming STARTED for this session,
        // not when it commits. Without this, a long-streaming leader's commit
        // lands AFTER fast specialists' commits even though the leader's
        // response began first. Stream-start lives in the chat store so
        // renderers can subscribe AND `appendOutputLines` can read it here.
        // Falls back to commit time for tool-only batches that never streamed.
        const streamStart = useChatStore.getState().streamStartedAt.get(sessionKey) ?? null
        if (streamStart !== null) {
          useChatStore.getState().clearStreamStart(sessionKey)
        }
        const timestamp = streamStart ?? Date.now()
        const entries: TranscriptEntry[] = lines.map((text) => ({
          entryId: crypto.randomUUID(),
          runId: agent?.runId ?? null,
          sessionKey,
          kind:
            text.startsWith('[[tool]]') || text.startsWith('[[tool-result]]')
              ? ('tool' as const)
              : ('assistant' as const),
          role: 'assistant' as const,
          text,
          source: 'runtime-chat' as const,
          timestampMs: timestamp,
          // Each line in the batch gets a unique strictly-increasing
          // sequenceKey so the merged-view sort can break ties even when
          // every line shares the same timestamp.
          sequenceKey: nextSeq(),
          confirmed: true,
          fingerprint: crypto.randomUUID(),
        }))

        useChatStore.getState().appendTranscript(sessionKey, entries)

        // Best-effort persistence — never throw in an event handler
        const gwUrl = useConnectionStore.getState().gatewayUrl ?? ''
        void fetch('/api/chat-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey, gatewayUrl: gwUrl, entries }),
        }).catch(() => {})
      },

      // Re-fetch agent sessions after a chat final (best-effort). Routes through
      // the AgentSource (server delegates to the Gateway).
      requestHistoryRefresh: async (agentId, _reason) => {
        try {
          await listAgentSessions(agentId)
        } catch {
          // Ignore — transcript is built from events
        }
      },

      // Re-fetch the full agent list (debounced, triggered by presence/heartbeat).
      // Reads the registry from SQLite (the server-side AgentSource keeps it fresh
      // via its own Gateway event subscription) — no direct Gateway call here.
      loadSummarySnapshot: async () => {
        try {
          await refreshFleetFromRegistry()
        } catch {
          // Ignore
        }
      },

      // Heartbeat/presence confirmed agents are alive — update lastSeenAt for all running agents
      refreshHeartbeatLatest: () => {
        const now = Date.now()
        const agents = useFleetStore.getState().agents
        for (const agent of agents) {
          if (agent.status === 'running') {
            useFleetStore.getState().updateLastSeen(agent.id, now)
          }
        }
      },

      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    })

    // Subscribe to all gateway events
    const unsub = client.onEvent((frame) => {
      processEvent(frame, handler)
    })

    // ── Periodic expiry cleanup for pending approvals ──────────────────────
    // The Gateway does NOT emit exec.approval.resolved when an approval times
    // out — it resolves internally with null. Without this sweep, expired
    // approval cards would linger in the store indefinitely.
    //
    // Strategy: snapshot pending approvals BEFORE removing, find expired ones,
    // inject system messages into chat, then call removeExpired to clean store.
    const expiryTimer = setInterval(() => {
      const pending = useApprovalsStore.getState().pendingApprovals
      if (pending.size === 0) return

      const now = Date.now()
      const expired: ApprovalRequest[] = []
      for (const approval of pending.values()) {
        if (now > approval.expiresAtMs) {
          expired.push(approval)
        }
      }
      if (expired.length === 0) return

      // Inject a system message into each expired approval's chat transcript
      // so the user knows it timed out and needs to resend the command.
      for (const approval of expired) {
        const agentId = approval.agentId
        if (!agentId) continue

        const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
        // Approval-expiry meta entries inject into the agent's own session.
        const sessionKey = agent?.sessionKey
        if (!sessionKey) continue

        const entry: TranscriptEntry = {
          entryId: crypto.randomUUID(),
          runId: null,
          sessionKey,
          kind: 'meta',
          role: 'system',
          text: `Exec approval for \`${approval.command}\` timed out. Ask the agent to run the command again if needed.`,
          source: 'local-send',
          timestampMs: now,
          // Strictly-increasing tiebreaker (see lib/sequenceKey.ts).
          sequenceKey: nextSeq(),
          confirmed: true,
          fingerprint: crypto.randomUUID(),
        }
        useChatStore.getState().appendTranscript(sessionKey, [entry])
      }

      // Now remove expired approvals from the store (cards disappear)
      useApprovalsStore.getState().removeExpired()
    }, 5_000)

    return () => {
      unsub()
      clearInterval(expiryTimer)
      patchQueue.dispose()
      handler.dispose()
      // Stream-start anchors live in the chat store — they're
      // already wiped per-session via `clearStreamStart` at commit time
      // and via `clearTranscript` for session resets. No global cleanup
      // needed here.
    }
  }, [client])
}
