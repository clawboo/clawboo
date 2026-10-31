// SSE consumer for a server-run agent's 1:1 chat stream (Clawboo Native, Claude
// Code, Codex, Hermes), the analog of useTeamChatStream for the per-agent 1:1
// session. Reuses the pure frame appliers (applyCommittedFrame / applyDeltaFrame)
// so committed turns + live token deltas feed the chat store exactly the way the
// team + Gateway paths do.
// Inert when disabled or when EventSource is unavailable (SSR/jsdom) — ChatPanel
// still renders from its /api/chat-history hydration in that case.

import { useEffect, useRef } from 'react'

import {
  applyAgentStatusFrame,
  applyCommittedFrame,
  applyDeltaFrame,
  type EventSourceFactory,
} from '@/features/group-chat/useTeamChatStream'
import { apiUrl } from '@clawboo/control-client'

export interface UseNativeAgentChatStreamParams {
  agentId: string
  enabled: boolean
  /** Fired on every frame (committed OR delta) — drives the composer's busy signal. */
  onActivity?: () => void
  /** The turn's own run-state from the server's status frames: true from the run's
   *  start to its terminal. Reset to false on every (re)connect, before the server
   *  replays its snapshot, so a turn that ended while the stream was down (or a
   *  server that restarted mid-turn) cannot leave the composer stuck on Stop. */
  onTurnLive?: (live: boolean) => void
  /** Injectable for tests (jsdom has no `EventSource`). */
  eventSourceFactory?: EventSourceFactory
}

export function useNativeAgentChatStream({
  agentId,
  enabled,
  onActivity,
  onTurnLive,
  eventSourceFactory,
}: UseNativeAgentChatStreamParams): void {
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity
  const onTurnLiveRef = useRef(onTurnLive)
  onTurnLiveRef.current = onTurnLive

  useEffect(() => {
    if (!enabled) return
    const factory =
      eventSourceFactory ??
      (typeof EventSource !== 'undefined' ? (url: string) => new EventSource(url) : null)
    if (!factory) return

    const es = factory(apiUrl(`/api/agents/${encodeURIComponent(agentId)}/chat/stream`))
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
      const update = applyAgentStatusFrame(e.data as string)
      if (update && update.agentId === agentId) onTurnLiveRef.current?.(update.status === 'running')
      onActivityRef.current?.()
    }
    const onOpen = (): void => onTurnLiveRef.current?.(false)
    es.addEventListener('open', onOpen)
    es.addEventListener('message', onCommitted)
    es.addEventListener('delta', onDelta as EventListener)
    es.addEventListener('status', onStatus as EventListener)

    return () => {
      es.removeEventListener('open', onOpen)
      es.removeEventListener('message', onCommitted)
      es.removeEventListener('delta', onDelta as EventListener)
      es.removeEventListener('status', onStatus as EventListener)
      es.close()
      onTurnLiveRef.current?.(false)
    }
  }, [agentId, enabled, eventSourceFactory])
}
