import { useEffect } from 'react'
import type { GatewayClient } from '@clawboo/gateway-client'
import type { AgentStatusPatch } from '@clawboo/events'
import { createEventHandler, createPatchQueue, processEvent } from '@clawboo/events'
import { extractText, type TranscriptEntry } from '@clawboo/protocol'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalsStore, type ApprovalRequest } from '@/stores/approvals'
import { parseApprovalRequestPayload } from '@/features/approvals/useApprovalActions'
import { getTeamChatOverride, clearTeamChatOverride } from '@/lib/sessionUtils'
import { clearAllWakeRecords } from '@/lib/wakeTracker'

// ─── useGatewayEvents ─────────────────────────────────────────────────────────
//
// Wires a live GatewayClient into the Bridge → Policy → Handler pipeline.
// Call this hook once at the top of the app; it is a no-op when client is null.

export function useGatewayEvents(client: GatewayClient | null): void {
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
      getConnectionStatus: () => {
        const s = useConnectionStore.getState().status
        // Map our local 'error' state → 'disconnected' (handler only knows gateway statuses)
        return s === 'error' ? 'disconnected' : s
      },

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
            // Clear team-scoped streaming text in the chat store + team override.
            const teamKey = getTeamChatOverride(intent.agentId)
            if (teamKey) {
              useChatStore.getState().setStreamingText(teamKey, null)
              clearTeamChatOverride(intent.agentId)
            } else if (intent.sessionKey) {
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
        // Sync streaming text to chat store — use team override if active,
        // so GroupChatPanel reads streaming from the team sessionKey.
        const resolvedKey = (agentId ? getTeamChatOverride(agentId) : undefined) ?? sessionKey
        if (resolvedKey && patch.streamText !== undefined) {
          useChatStore.getState().setStreamingText(resolvedKey, patch.streamText)
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
        // Team chat override: the Gateway echoes events with the main sessionKey even
        // when we sent to a team-scoped key. Redirect to the team session if active.
        const teamOverride = agentId ? getTeamChatOverride(agentId) : undefined
        const sessionKey = teamOverride ?? eventSessionKey ?? agent?.sessionKey
        if (!sessionKey) return

        const now = Date.now()
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
          timestampMs: now,
          sequenceKey: now,
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

      // Re-fetch agent sessions after a chat final (best-effort)
      requestHistoryRefresh: async (agentId, _reason) => {
        const cl = useConnectionStore.getState().client
        if (!cl) return
        try {
          await cl.sessions.list(agentId)
          // Sessions list refreshed — agent's sessionKey stays current via hydration
        } catch {
          // Ignore — transcript is built from events
        }
      },

      // Re-fetch the full agent list (debounced, triggered by presence/heartbeat)
      loadSummarySnapshot: async () => {
        const cl = useConnectionStore.getState().client
        if (!cl) return
        try {
          const result = await cl.agents.list()
          const mainKey = result.mainKey?.trim() || 'main'
          // Preserve existing teamId + execConfig assignments — Gateway doesn't know about these
          const existing = useFleetStore.getState().agents
          const existingTeamIds = new Map(existing.map((a) => [a.id, a.teamId]))
          const existingExecConfigs = new Map(existing.map((a) => [a.id, a.execConfig]))
          useFleetStore.getState().hydrateAgents(
            result.agents.map((a) => ({
              id: a.id,
              name: a.identity?.name ?? a.name ?? a.id,
              status: 'idle' as const,
              sessionKey: `agent:${a.id}:${mainKey}`,
              model: null,
              createdAt: null,
              streamingText: null,
              runId: null,
              lastSeenAt: null,
              teamId: existingTeamIds.get(a.id) ?? null,
              execConfig: existingExecConfigs.get(a.id) ?? null,
            })),
          )
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

    // ── Token tracking: extract or estimate token usage from final chat events ─
    const unsubCost = client.onEvent((frame) => {
      if (frame.event !== 'chat') return
      const p = frame.payload as Record<string, unknown> | null
      if (!p || p['state'] !== 'final') return

      // Resolve agentId from session key format "agent:<id>:<session>"
      const sk = typeof p['sessionKey'] === 'string' ? p['sessionKey'] : ''
      const agentMatch = sk.match(/^agent:([^:]+):/)
      const agentId = agentMatch ? agentMatch[1]! : ''
      if (!agentId) return

      const message = p['message'] as Record<string, unknown> | null | undefined
      if (!message) return

      // Try real usage from Gateway, fall back to estimation from response text
      const usage = (() => {
        const direct = message['usage'] as Record<string, unknown> | null | undefined
        if (direct) return direct
        const meta = message['metadata'] as Record<string, unknown> | null | undefined
        return (meta?.['usage'] as Record<string, unknown> | null | undefined) ?? null
      })()

      let inputTokens = 0
      let outputTokens = 0

      if (usage) {
        // Real token data from Gateway (when available)
        inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
        outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
      } else {
        // Estimate from response text — same formula as chat UI (~charCount/4)
        const responseText = extractText(message) ?? ''
        if (responseText.length > 0) {
          outputTokens = Math.ceil(responseText.length / 4)
        }

        // Estimate input from the last user message in this agent's transcript
        const teamKey = getTeamChatOverride(agentId)
        const mainKey = useFleetStore.getState().agents.find((a) => a.id === agentId)?.sessionKey
        const transcript = useChatStore.getState().transcripts.get(teamKey ?? mainKey ?? '')
        if (transcript) {
          for (let i = transcript.length - 1; i >= 0; i--) {
            if (transcript[i]!.kind === 'user') {
              inputTokens = Math.ceil(transcript[i]!.text.length / 4)
              break
            }
          }
        }
      }

      if (inputTokens === 0 && outputTokens === 0) return

      const model =
        typeof p['model'] === 'string'
          ? p['model']
          : typeof message['model'] === 'string'
            ? message['model']
            : 'unknown'
      const runId = typeof p['runId'] === 'string' ? p['runId'] : null

      // Store token usage in chat store so ChatPanel can display real counts
      if (runId) {
        useChatStore.getState().setLastTokenUsage(runId, inputTokens, outputTokens)
      }

      void fetch('/api/cost-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, model, inputTokens, outputTokens, runId }),
      }).catch(() => {
        // best-effort — never throw in event handlers
      })
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
        const teamOverride = getTeamChatOverride(agentId)
        const sessionKey = teamOverride ?? agent?.sessionKey
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
          sequenceKey: now,
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
      unsubCost()
      clearInterval(expiryTimer)
      patchQueue.dispose()
      handler.dispose()
      clearAllWakeRecords()
    }
  }, [client])
}
