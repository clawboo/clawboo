'use client'

import { useEffect } from 'react'
import type { GatewayClient } from '@clawboo/gateway-client'
import type { AgentStatusPatch } from '@clawboo/events'
import { createEventHandler, createPatchQueue, processEvent } from '@clawboo/events'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalsStore } from '@/stores/approvals'
import { parseApprovalRequestPayload } from '@/features/approvals/useApprovalActions'

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
          case 'updateAgentStatus':
            useFleetStore.getState().patchAgent(intent.agentId, intent.patch)
            break
          case 'commitChat':
            // outputLines already handled by appendOutputLines above;
            // apply the final status patch (idle/error, runId cleared)
            useFleetStore.getState().patchAgent(intent.agentId, intent.patch)
            break
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
      queueLivePatch: (agentId, patch) => {
        patchQueue.enqueue({ agentId, updates: patch })
      },

      // Flush all pending patches for an agent immediately
      clearPendingLivePatch: (_agentId) => {
        patchQueue.flush()
      },

      // Append committed output lines to the chat transcript
      appendOutputLines: (agentId, lines) => {
        if (lines.length === 0) return
        const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
        const sessionKey = agent?.sessionKey
        if (!sessionKey) return

        const now = Date.now()
        const entries: TranscriptEntry[] = lines.map((text) => ({
          entryId: crypto.randomUUID(),
          runId: agent.runId,
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
            })),
          )
        } catch {
          // Ignore
        }
      },

      // Heartbeat refresh — no-op for Phase 2
      refreshHeartbeatLatest: () => {},

      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    })

    // Subscribe to all gateway events
    const unsub = client.onEvent((frame) => {
      processEvent(frame, handler)
    })

    // ── Cost tracking: extract token usage from final chat events ────────────
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

      // Extract usage from message.usage or message.metadata.usage
      const usage = (() => {
        const direct = message['usage'] as Record<string, unknown> | null | undefined
        if (direct) return direct
        const meta = message['metadata'] as Record<string, unknown> | null | undefined
        return (meta?.['usage'] as Record<string, unknown> | null | undefined) ?? null
      })()
      if (!usage) return

      const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
      const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
      if (inputTokens === 0 && outputTokens === 0) return

      const model =
        typeof p['model'] === 'string'
          ? p['model']
          : typeof message['model'] === 'string'
            ? message['model']
            : 'default'
      const runId = typeof p['runId'] === 'string' ? p['runId'] : null

      void fetch('/api/cost-records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, model, inputTokens, outputTokens, runId }),
      }).catch(() => {
        // best-effort — never throw in event handlers
      })
    })

    return () => {
      unsub()
      unsubCost()
      handler.dispose()
    }
  }, [client])
}
