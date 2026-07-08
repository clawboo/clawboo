// Thin-client send for a clawboo-native agent's 1:1 chat (the Boo-Zero personal
// chat). The analog of the group chat's serverTeamChatSend: append an optimistic
// user bubble + POST to the native chat ingest; the reply streams back via
// useNativeAgentChatStream. NO Gateway client — this is the native path that
// replaces `client.chat.send` (which only knows OpenClaw agents).

import type { TranscriptEntry } from '@clawboo/protocol'

import { nextSeq } from '@/lib/sequenceKey'
import { useChatStore } from '@/stores/chat'

export interface SendNativeAgentParams {
  agentId: string
  sessionKey: string
  /** The context-injected message delivered to the model (rules block + any @team
   *  brief/history prepended by ChatPanel). */
  message: string
  /** The original user text shown in the transcript. */
  displayText: string
}

function makeUserEntry(sessionKey: string, text: string, entryId: string): TranscriptEntry {
  const now = Date.now()
  return {
    entryId,
    runId: null,
    source: 'local-send',
    timestampMs: now,
    sequenceKey: nextSeq(),
    confirmed: true,
    fingerprint: entryId,
    kind: 'user',
    role: 'user',
    text,
    sessionKey,
  }
}

/** Send a message to a native agent's 1:1 chat. Optimistically appends the user
 *  bubble (entryId shared with the server's persisted copy so the SSE replay dedups),
 *  then POSTs the ingest. The streamed reply arrives via the SSE. */
export async function sendNativeAgentMessage({
  agentId,
  sessionKey,
  message,
  displayText,
}: SendNativeAgentParams): Promise<void> {
  const trimmed = message.trim()
  if (!trimmed) return
  const shownText = displayText.trim() || trimmed
  const entryId = crypto.randomUUID()
  useChatStore.getState().appendTranscript(sessionKey, [makeUserEntry(sessionKey, shownText, entryId)])

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: trimmed, displayText: shownText, entryId }),
    })
    if (!res.ok) throw new Error(`ingest ${res.status}`)
  } catch (err) {
    const errText = err instanceof Error ? err.message : 'send failed'
    const errEntry = makeUserEntry(sessionKey, `Error: could not reach the agent (${errText}).`, crypto.randomUUID())
    useChatStore.getState().appendTranscript(sessionKey, [
      { ...errEntry, kind: 'meta', role: 'system' },
    ])
  }
}

/** Abort the in-flight conversational turn (the composer's Stop button). */
export async function stopNativeAgentChat(agentId: string): Promise<void> {
  try {
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/chat/stop`, { method: 'POST' })
  } catch {
    // best-effort
  }
  // Optimistically clear local streaming so the UI flips to idle immediately.
  useChatStore.getState().setStreamingText(`agent:${agentId}:native`, null)
}
