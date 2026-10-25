// Thin-client REST send + stop for SERVER-orchestrated (native) teams.
//
// The browser never talks to a Gateway for these teams — it POSTs the user message
// to the server orchestrator (which persists it + drives the cascade) and renders
// the result over the SSE stream (`useTeamChatStream`). This mirrors the role
// `sendGroupChatMessage` / `stopAllInTeam` play for OpenClaw teams, but with ZERO
// `client` dependency (native mode has `client === null`).

import type { TranscriptEntry } from '@clawboo/protocol'
import { apiFetch } from '@clawboo/control-client'

import { resetOpenClawTeammates } from '@/features/chat/resetConversation'
import { nextSeq } from '@/lib/sequenceKey'
import { buildTeamSessionKey } from '@/lib/sessionUtils'
import { isBooZeroEligibleForTeam, useBooZeroStore } from '@/stores/booZero'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import type { Room } from '@/lib/roomsClient'
import { useRoomStore } from '@/stores/rooms'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

export interface SendServerTeamMessageParams {
  teamId: string
  /** One of the team's chat rooms; null/absent = the team's own group chat. */
  roomId?: string | null
  /** The routing target (mention > leader > first member), resolved client-side so
   *  the optimistic bubble lands under the right key; the server re-resolves it
   *  authoritatively (explicit target wins). */
  targetAgentId: string
  /** `buildTeamSessionKey(targetAgentId, teamId)` — the merged-view key the optimistic
   *  user entry is stored under. The render derives "You → name" from this key. */
  targetSessionKey: string
  message: string
}

/** Optimistically show the user's message, then POST it to the server orchestrator.
 *  The client-generated `entryId` is threaded to the server (see the ingest route)
 *  so the SSE-replayed user entry dedups against the optimistic one by entryId —
 *  no double-render. Best-effort: a failed POST toasts but leaves the bubble (it
 *  reflects intent; a retry re-sends). */
/**
 * Returns whether the server accepted the message.
 *
 * REPORTED rather than swallowed, because a caller that guards against
 * double-submit needs to know the difference between "sent" and "failed": the
 * first must stay locked, the second has to become retryable or the user is
 * stuck looking at a dead button.
 */
export async function sendServerTeamMessage(params: SendServerTeamMessageParams): Promise<boolean> {
  const { teamId, roomId, targetAgentId, targetSessionKey, message } = params
  const entryId = crypto.randomUUID()

  const optimistic: TranscriptEntry = {
    entryId,
    role: 'user',
    kind: 'user',
    text: message,
    sessionKey: targetSessionKey,
    runId: null,
    source: 'local-send',
    timestampMs: Date.now(),
    sequenceKey: nextSeq(),
    confirmed: true,
    fingerprint: crypto.randomUUID(),
  }
  useChatStore.getState().appendTranscript(targetSessionKey, [optimistic])

  try {
    const res = await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        targetAgentId,
        entryId,
        ...(roomId ? { roomId } : {}),
      }),
    })
    if (!res.ok) {
      useToastStore
        .getState()
        .addToast({ message: 'Could not reach the team. Try again?', type: 'error' })
      return false
    }
    return true
  } catch {
    useToastStore
      .getState()
      .addToast({ message: 'Could not reach the team. Try again?', type: 'error' })
    return false
  }
}

export interface StopServerTeamParams {
  teamId: string
  /** Stop only this chat room's cascade; null/absent = the team's own group chat. */
  roomId?: string | null
  /** Team-scoped session keys to clear locally (streaming text + stream-start). */
  sessionKeys: string[]
}

/** User Stop for a server-orchestrated team: tell the server to abort in-flight runs
 *  + clear the local streaming state so the composer flips back to Send at once. The
 *  server's abort → clean release to `todo` is the authoritative teardown; this is
 *  best-effort (the server's idle watchdog is the backstop). */
export async function stopServerTeam(params: StopServerTeamParams): Promise<void> {
  const { teamId, roomId, sessionKeys } = params
  const chat = useChatStore.getState()
  for (const sk of sessionKeys) {
    chat.setStreamingText(sk, null)
    chat.clearStreamStart(sk)
  }
  try {
    await apiFetch(`/api/teams/${encodeURIComponent(teamId)}/chat/stop`, {
      method: 'POST',
      ...(roomId
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId }) }
        : {}),
    })
  } catch {
    // best-effort — the server also releases via its idle watchdog
  }
}

/**
 * Clear one chat: the team's General chat (the virtual room with an empty id) or
 * one of its rooms. The server sets its messages aside and drops the agents'
 * memory of the conversation; here the transcripts on screen go too. Other chats
 * are untouched. Resolves true on success.
 */
export async function clearServerTeamChat(room: Room): Promise<boolean> {
  const roomId = room.id || null
  let clearedAt: number
  try {
    const res = await apiFetch(`/api/teams/${encodeURIComponent(room.teamId)}/chat/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomId ? { roomId } : {}),
    })
    if (!res.ok) return false
    clearedAt = ((await res.json()) as { clearedAt: number }).clearedAt
  } catch {
    return false
  }
  // A chat's keys are `agent:<id>:team:<teamId>`, plus `:room:<roomId>` in a room.
  const suffix = roomId ? `:team:${room.teamId}:room:${roomId}` : `:team:${room.teamId}`
  const chat = useChatStore.getState()
  const keys = new Set([...chat.transcripts.keys(), ...chat.streamingText.keys()])
  for (const key of keys) {
    if (key.startsWith('agent:') && key.endsWith(suffix)) chat.clearTranscript(key) // its live stream too
  }
  if (roomId) useRoomStore.getState().upsert({ ...room, chatClearedAt: clearedAt })
  else useTeamStore.getState().updateTeam(room.teamId, { chatClearedAt: clearedAt })
  // The server dropped the resume pointers clawboo keeps. An OpenClaw teammate's
  // conversation lives in the Gateway, so it gets the same `/reset` the chat sends.
  await resetOpenClawTeammates(useConnectionStore.getState().client, chatTeammates(room), (id) =>
    buildTeamSessionKey(id, room.teamId, roomId),
  )
  return true
}

/** The agents a chat is between: the team, or the room's members still on it,
 *  plus Boo Zero, who presides over every chat. */
function chatTeammates(room: Room): Array<{ id: string; runtime?: string | null }> {
  const agents = useFleetStore.getState().agents
  const members = room.id ? new Set(room.memberIds) : null
  const inChat = agents.filter(
    (a) => a.teamId === room.teamId && (members === null || members.has(a.id)),
  )
  const booZeroId = useBooZeroStore.getState().booZeroAgentId
  const booZero = booZeroId ? agents.find((a) => a.id === booZeroId) : undefined
  if (
    booZero &&
    isBooZeroEligibleForTeam(booZero, room.teamId) &&
    !inChat.some((a) => a.id === booZero.id)
  ) {
    inChat.push(booZero)
  }
  return inChat
}
