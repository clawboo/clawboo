// The native analog of `useGatewayEvents`: subscribe a SERVER-orchestrated team's
// SSE transcript stream into the chat store. Committed turns + live token deltas
// from `GET /api/teams/:id/chat/stream` (the pure DB-tail reader) are appended /
// replaced exactly the way the Gateway path feeds the store — so `GroupChatPanel`
// renders a server-driven cascade with no other changes.
//
// The SSE frame contract (see `apps/web/server/api/teamChatStream.ts`):
//   • committed: default `message` event, `data` = a serialized `TranscriptEntry`,
//     carries an `id:` (the resume cursor). Dedup by entryId (the full-replay-from-0
//     on connect, the `/api/chat-history` hydration, AND the optimistic user bubble
//     all carry matching entryIds).
//   • delta:     `event: delta`, `data` = { sessionKey, runId, text } with the FULL
//     running text (REPLACE), NO `id:` (ephemeral — never advances the cursor).
//   • board:     `event: board`, `data` = a `BoardChange`, NO `id:` (ephemeral). Applied
//     to the board projection store so a cascade's BoardTaskCards update live; a
//     gap-missed change is reconciled by a `GET /api/board` reload on (re)connect.

import { useEffect, useRef } from 'react'

import type { TranscriptEntry } from '@clawboo/protocol'

import type { BoardChange } from '@/features/group-chat/boardOrchestration'
import { useBoardStore } from '@/stores/board'
import { useChatStore } from '@/stores/chat'

export interface TeamChatDelta {
  sessionKey: string
  runId: string | null
  text: string
}

/** Apply one committed frame (a full `TranscriptEntry`) to the store. Dedup by
 *  entryId + content signature lives in `appendTranscript`. When an assistant turn
 *  commits, its live delta is dropped (streaming text + stream-start cleared) so the
 *  committed card replaces the streaming card in the same chronological slot. */
export function applyCommittedFrame(raw: string): void {
  let entry: TranscriptEntry
  try {
    entry = JSON.parse(raw) as TranscriptEntry
  } catch {
    return
  }
  if (!entry || typeof entry.sessionKey !== 'string' || typeof entry.entryId !== 'string') return
  const chat = useChatStore.getState()
  chat.appendTranscript(entry.sessionKey, [entry])
  if (entry.kind === 'assistant') {
    chat.setStreamingText(entry.sessionKey, null)
    chat.clearStreamStart(entry.sessionKey)
  }
}

/** Apply a live token delta: REPLACE the session's streaming text (the delta carries
 *  the FULL running text) + anchor its stream-start slot (first-capture-wins, so the
 *  live card sorts at the moment the turn began, not always-at-the-end). */
export function applyDeltaFrame(raw: string): void {
  let delta: TeamChatDelta
  try {
    delta = JSON.parse(raw) as TeamChatDelta
  } catch {
    return
  }
  if (!delta || typeof delta.sessionKey !== 'string' || typeof delta.text !== 'string') return
  const chat = useChatStore.getState()
  chat.setStreamingText(delta.sessionKey, delta.text)
  chat.setStreamStart(delta.sessionKey, Date.now())
}

/** Apply a board-projection change frame: last-write-wins into the board store for
 *  the given team. Cursor-less/ephemeral; a gap-missed change is reconciled by the
 *  `open`-triggered `load(teamId)`. */
export function applyBoardChangeFrame(teamId: string, raw: string): void {
  let change: BoardChange
  try {
    change = JSON.parse(raw) as BoardChange
  } catch {
    return
  }
  if (!change || typeof change.id !== 'string') return
  useBoardStore.getState().applyChange(teamId, change)
}

export type EventSourceFactory = (url: string) => EventSource

export interface UseTeamChatStreamParams {
  teamId: string
  enabled: boolean
  /** Fired on every frame (committed OR delta) — drives the composer's activity-
   *  window busy signal. */
  onActivity?: () => void
  /** Injectable for tests (jsdom has no `EventSource`). */
  eventSourceFactory?: EventSourceFactory
}

/** Subscribe the team's SSE transcript stream while `enabled`. Inert when disabled or
 *  when `EventSource` is unavailable (SSR/jsdom) — the panel still renders from the
 *  `/api/chat-history` hydration in that case. Reopens on `teamId` change. */
export function useTeamChatStream({
  teamId,
  enabled,
  onActivity,
  eventSourceFactory,
}: UseTeamChatStreamParams): void {
  // Keep `onActivity` out of the effect deps so a fresh inline callback each render
  // doesn't tear down + reopen the stream.
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity

  useEffect(() => {
    if (!enabled) return
    const factory =
      eventSourceFactory ??
      (typeof EventSource !== 'undefined' ? (url: string) => new EventSource(url) : null)
    if (!factory) return

    const es = factory(`/api/teams/${encodeURIComponent(teamId)}/chat/stream`)

    const onCommitted = (e: MessageEvent): void => {
      applyCommittedFrame(e.data as string)
      onActivityRef.current?.()
    }
    const onDelta = (e: MessageEvent): void => {
      applyDeltaFrame(e.data as string)
      onActivityRef.current?.()
    }
    const onBoard = (e: MessageEvent): void => {
      applyBoardChangeFrame(teamId, e.data as string)
      onActivityRef.current?.()
    }
    // On (re)connect, reconcile any board change missed during the gap (board frames
    // are cursor-less). Idempotent last-write-wins merge; the initial-connect load is
    // redundant with GroupChatPanel's mount load but harmless.
    const onOpen = (): void => {
      void useBoardStore.getState().load(teamId)
    }
    es.addEventListener('message', onCommitted)
    es.addEventListener('delta', onDelta as EventListener)
    es.addEventListener('board', onBoard as EventListener)
    es.addEventListener('open', onOpen)

    return () => {
      es.removeEventListener('message', onCommitted)
      es.removeEventListener('delta', onDelta as EventListener)
      es.removeEventListener('board', onBoard as EventListener)
      es.removeEventListener('open', onOpen)
      es.close()
    }
  }, [teamId, enabled, eventSourceFactory])
}
