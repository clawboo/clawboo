// Thin-client REST send + stop for SERVER-orchestrated (native) teams.
//
// The browser never talks to a Gateway for these teams — it POSTs the user message
// to the server orchestrator (which persists it + drives the cascade) and renders
// the result over the SSE stream (`useTeamChatStream`). This mirrors the role
// `sendGroupChatMessage` / `stopAllInTeam` play for OpenClaw teams, but with ZERO
// `client` dependency (native mode has `client === null`).

import type { TranscriptEntry } from '@clawboo/protocol'

import { nextSeq } from '@/lib/sequenceKey'
import { useChatStore } from '@/stores/chat'
import { useToastStore } from '@/stores/toast'

export interface SendServerTeamMessageParams {
  teamId: string
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
export async function sendServerTeamMessage(params: SendServerTeamMessageParams): Promise<void> {
  const { teamId, targetAgentId, targetSessionKey, message } = params
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
    const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, targetAgentId, entryId }),
    })
    if (!res.ok) {
      useToastStore.getState().addToast({ message: 'Could not reach the team. Try again?', type: 'error' })
    }
  } catch {
    useToastStore.getState().addToast({ message: 'Could not reach the team. Try again?', type: 'error' })
  }
}

export interface StopServerTeamParams {
  teamId: string
  /** Team-scoped session keys to clear locally (streaming text + stream-start). */
  sessionKeys: string[]
}

/** User Stop for a server-orchestrated team: tell the server to abort in-flight runs
 *  + clear the local streaming state so the composer flips back to Send at once. The
 *  server's abort → clean release to `todo` is the authoritative teardown; this is
 *  best-effort (the server's idle watchdog is the backstop). */
export async function stopServerTeam(params: StopServerTeamParams): Promise<void> {
  const { teamId, sessionKeys } = params
  const chat = useChatStore.getState()
  for (const sk of sessionKeys) {
    chat.setStreamingText(sk, null)
    chat.clearStreamStart(sk)
  }
  try {
    await fetch(`/api/teams/${encodeURIComponent(teamId)}/chat/stop`, { method: 'POST' })
  } catch {
    // best-effort — the server also releases via its idle watchdog
  }
}
