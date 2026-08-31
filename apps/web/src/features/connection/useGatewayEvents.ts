import { useEffect } from 'react'
import type { GatewayClient } from '@clawboo/gateway-client'
import type { AgentStatusPatch, ChatCost } from '@clawboo/events'
import { createEventHandler, createPatchQueue, processEvent } from '@clawboo/events'
import type { TranscriptEntry } from '@clawboo/protocol'
import { isTeamSessionKey } from '@clawboo/team-orchestration'
import { apiFetch, listAgentSessions } from '@clawboo/control-client'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalsStore, type ApprovalRequest } from '@/stores/approvals'
import { parseApprovalRequestPayload } from '@/features/approvals/useApprovalActions'
import { nextSeq } from '@/lib/sequenceKey'
import { refreshFleetFromRegistry } from '@/lib/agentSourceClient'
import { nextMirroredStatus } from './socketStatusMirror'
import { userStoppedRecently } from '@/features/chat/stopChatOperation'

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
/**
/**
 * Provider phrasings for "the prompt did not fit".
 *
 * COPIED, not imported, for the same reason as the sentence below: the server's
 * `isContextOverflowMessage` lives beside runtime code that must never enter the
 * browser bundle. Kept character-for-character with
 * `apps/web/server/lib/runtimes/native/providers/types.ts`, and both sides are
 * pinned by tests, so a change to one breaks the other's test.
 */
const CONTEXT_OVERFLOW_RE =
  /context[\s_-]?(?:overflow|length|window|limit)|(?:prompt|input) (?:is )?too (?:large|long)|maximum context|exceeds? (?:the )?(?:maximum )?context|too many tokens|reduce the length of the (?:messages|prompt)/i

/**
 * The sentence for a Gateway run that ended in `error` having said nothing.
 *
 * PARITY WITH THE SERVER'S `runFailureText`, COPIED RATHER THAN IMPORTED. That
 * module reaches `runtimes/descriptor`, which is server code and must never
 * enter the browser bundle, and `apps/web/src` may not import from
 * `apps/web/server` at all.
 *
 * The no-provider-key arm is deliberately absent: it names a clawboo runtime to
 * go and fix, and a Gateway session is an OpenClaw agent whose keys live
 * somewhere this app cannot point at. The no-reason case borrows the wording the
 * team drain already uses for a run that reported nothing, rather than telling
 * the operator "unknown error" and leaving them there.
 */
export function gatewayRunFailureText(reason: string | null | undefined): string {
  const trimmed = reason?.trim()
  if (!trimmed) {
    return 'The run ended without reporting a result. The connection to the runtime may have dropped; try sending again.'
  }
  // A CONTEXT-OVERFLOW LABEL IS RARELY ABOUT AN OVERSIZED PROMPT, and this is
  // the arm an OpenClaw chat actually reaches, so it matters more here than on
  // the server copy. Traced on a real install: a prompt of about 32,000 tokens
  // against a model with a 204,800-token window, failing because the runtime had
  // resolved a budget of 32,768 (the model's max OUTPUT tokens), started
  // compacting at 32,106, and could not free anything, since compaction cannot
  // reach tool definitions and they were 50,405 bytes of every prompt.
  //
  // The runtime's own advice is "/reset (or /new)", which clears the
  // conversation: the one part that was not the problem. An operator followed it
  // five times.
  if (CONTEXT_OVERFLOW_RE.test(trimmed)) {
    return (
      'This run stopped because the runtime believed it was out of context room. ' +
      'That is usually a wrong context-window setting rather than a genuinely oversized prompt: ' +
      'a runtime that resolves a small budget starts compacting early, and compaction cannot shrink ' +
      'tool definitions, so it frees nothing and the turn fails again. ' +
      "Check the model's real context window in Settings, and reduce how many connectors this " +
      'agent is granted if its tool list has grown. Starting a fresh session clears the ' +
      'conversation but not the cause.'
    )
  }
  return `The run failed: ${trimmed}`
}

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

  void apiFetch('/api/cost-records', {
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
    const appendOutputLines = (
      agentId: string,
      lines: string[],
      eventSessionKey?: string,
      /** The run to stamp, for a caller that fires after the terminal patch
       *  has already cleared it off the fleet store. */
      runIdOverride?: string | null,
      /** Write as a SYSTEM NOTICE rather than as the agent speaking. A failed run
       *  did not say this; clawboo is saying it about the run. */
      asNotice = false,
    ): void => {
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
        runId: runIdOverride ?? agent?.runId ?? null,
        sessionKey,
        kind: asNotice
          ? ('meta' as const)
          : text.startsWith('[[tool]]') || text.startsWith('[[tool-result]]')
            ? ('tool' as const)
            : ('assistant' as const),
        role: asNotice ? ('system' as const) : ('assistant' as const),
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
      void apiFetch('/api/chat-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey, gatewayUrl: gwUrl, entries }),
      }).catch(() => {})
    }

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
            // RECOVER THE PROSE BEFORE THE PATCH CLEARS THE RUN. A terminal
            // frame that re-carries no assistant text (`aborted`, `error`, or a
            // `final` whose message has only tool lines) appended nothing above,
            // so the clear below used to delete the reply the operator had just
            // watched stream and put nothing in its place.
            //
            // BEFORE `patchAgent`, deliberately: the patch sets `runId: null`,
            // and a recovered entry stamped with a null run loses its token and
            // cost footer, which is keyed on the run.
            if (intent.sessionKey && !isTeamSessionKey(intent.sessionKey)) {
              const sessionKey = intent.sessionKey
              const live = useChatStore.getState().streamingText.get(sessionKey)
              // PROSE, not "any line". A tool-only final carries `[[tool]]`
              // entries, so gating on an empty list would miss exactly the case
              // where a run ends with tool output and the prose is dropped.
              const committedProse = intent.outputLines.some(
                (l) => !l.startsWith('[[tool]]') && !l.startsWith('[[tool-result]]'),
              )
              const stopped = userStoppedRecently(sessionKey)
              const recent = (useChatStore.getState().transcripts.get(sessionKey) ?? []).slice(-10)
              let saidSomething = committedProse
              if (live && live.trim() !== '' && !committedProse && !stopped) {
                // The approval-pending branch above commits WITHOUT clearing the
                // card, so this text may already be in the transcript and a
                // second copy would both render and persist.
                if (!recent.some((e) => e.kind === 'assistant' && e.text === live)) {
                  appendOutputLines(intent.agentId, [live], sessionKey, intent.runId)
                }
                saidSomething = true
              }

              // A FAILED RUN THAT SAID NOTHING MUST STILL SAY WHY. Without this
              // the turn is a silent non-response: an optimistic bubble, a brief
              // Working badge, then nothing under a header that has gone red.
              // The native path has written this notice for a while
              // (agentChat/driveAgentChat.ts:226-235); the Gateway path never did.
              //
              // The intent already carries both halves: `work.ts:149-152` sets
              // `status: 'error'` and puts the runtime's own message on
              // `streamText`, so nothing new has to be plumbed for this.
              if (intent.patch.status === 'error' && !saidSomething && !stopped) {
                // A LATER error frame for a run that already answered must not
                // append a failure under a good reply. `saidSomething` covers
                // only this commit, so the run's own transcript is checked too.
                const runAlreadySpoke = recent.some(
                  (e) =>
                    e.kind === 'assistant' && intent.runId !== null && e.runId === intent.runId,
                )
                if (!runAlreadySpoke) {
                  appendOutputLines(
                    intent.agentId,
                    [gatewayRunFailureText(intent.patch.streamText)],
                    sessionKey,
                    intent.runId,
                    true,
                  )
                }
              }
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
      appendOutputLines,

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
    //
    // Deliberately a bare interval, NOT `useVisiblePolling`: this sweep makes no
    // request (it reads the store), and it is wall-clock correctness — pausing it
    // in a hidden tab would leave expired approval cards standing and delay the
    // "timed out" transcript entry until the user came back.
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
