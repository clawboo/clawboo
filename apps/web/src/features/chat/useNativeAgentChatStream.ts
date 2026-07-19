// SSE consumer for a clawboo-native agent's 1:1 chat stream — the analog of
// useTeamChatStream for the per-agent `agent:<id>:native` session. Reuses the pure
// frame appliers (applyCommittedFrame / applyDeltaFrame) so committed turns + live
// token deltas feed the chat store exactly the way the team + Gateway paths do.
// Inert when disabled or when EventSource is unavailable (SSR/jsdom) — ChatPanel
// still renders from its /api/chat-history hydration in that case.

import { useEffect, useRef } from 'react'

import {
  applyAgentStatusFrame,
  applyCommittedFrame,
  applyDeltaFrame,
  type EventSourceFactory,
} from '@/features/group-chat/useTeamChatStream'

export interface UseNativeAgentChatStreamParams {
  agentId: string
  enabled: boolean
  /** Fired on every frame (committed OR delta) — drives the composer's busy signal. */
  onActivity?: () => void
  /** Injectable for tests (jsdom has no `EventSource`). */
  eventSourceFactory?: EventSourceFactory
}

export function useNativeAgentChatStream({
  agentId,
  enabled,
  onActivity,
  eventSourceFactory,
}: UseNativeAgentChatStreamParams): void {
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity

  useEffect(() => {
    if (!enabled) return
    const factory =
      eventSourceFactory ??
      (typeof EventSource !== 'undefined' ? (url: string) => new EventSource(url) : null)
    if (!factory) return

    const es = factory(`/api/agents/${encodeURIComponent(agentId)}/chat/stream`)
    const onCommitted = (e: MessageEvent): void => {
      applyCommittedFrame(e.data as string)
      onActivityRef.current?.()
    }
    const onDelta = (e: MessageEvent): void => {
      applyDeltaFrame(e.data as string)
      onActivityRef.current?.()
    }
    // Live working/idle badge for the left pane — the server publishes run-boundary
    // status frames; the applier patches the fleet store (nothing else reports
    // run-state for a native 1:1 turn).
    const onStatus = (e: MessageEvent): void => {
      applyAgentStatusFrame(e.data as string)
      onActivityRef.current?.()
    }
    es.addEventListener('message', onCommitted)
    es.addEventListener('delta', onDelta as EventListener)
    es.addEventListener('status', onStatus as EventListener)

    return () => {
      es.removeEventListener('message', onCommitted)
      es.removeEventListener('delta', onDelta as EventListener)
      es.removeEventListener('status', onStatus as EventListener)
      es.close()
    }
  }, [agentId, enabled, eventSourceFactory])
}
