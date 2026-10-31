// Thin-client send for a 1:1 chat the SERVER runs: a Clawboo Native agent (and the
// Boo-Zero personal chat), and a Claude Code, Codex or Hermes agent. The analog of
// the group chat's serverTeamChatSend: append an optimistic user bubble + POST to
// the 1:1 ingest; the reply streams back via useNativeAgentChatStream. NO Gateway
// client: `client.chat.send` only knows OpenClaw agents.

import type { TranscriptEntry } from '@clawboo/protocol'
import { apiFetch } from '@clawboo/control-client'

import { nextSeq } from '@/lib/sequenceKey'
import { useChatStore } from '@/stores/chat'

/** Runtimes whose 1:1 chat the server drives (`POST /api/agents/:id/chat`). Every
 *  other agent (OpenClaw) chats over the Gateway. `clawboo-mock` is the flagged test
 *  harness, which the server only runs when its env flag is set. */
const SERVER_CHAT_RUNTIMES = new Set([
  'clawboo-native',
  'claude-code',
  'codex',
  'hermes',
  'clawboo-mock',
])

/** Whether an agent on `runtime` chats 1:1 through the server rather than the Gateway. */
export function runsChatOnServer(runtime: string | null | undefined): boolean {
  return !!runtime && SERVER_CHAT_RUNTIMES.has(runtime)
}

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

/** Send a message to a server-run agent's 1:1 chat. Optimistically appends the user
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
  useChatStore
    .getState()
    .appendTranscript(sessionKey, [makeUserEntry(sessionKey, shownText, entryId)])

  try {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: trimmed, displayText: shownText, entryId }),
    })
    if (!res.ok) throw new Error(`ingest ${res.status}`)
  } catch (err) {
    const errText = err instanceof Error ? err.message : 'send failed'
    const errEntry = makeUserEntry(
      sessionKey,
      `Error: could not reach the agent (${errText}).`,
      crypto.randomUUID(),
    )
    useChatStore
      .getState()
      .appendTranscript(sessionKey, [{ ...errEntry, kind: 'meta', role: 'system' }])
  }
}

/** Abort the in-flight conversational turn (the composer's Stop button). */
export async function stopNativeAgentChat(agentId: string, sessionKey: string): Promise<void> {
  try {
    await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/chat/stop`, { method: 'POST' })
  } catch {
    // best-effort
  }
  // Optimistically clear local streaming so the UI flips to idle immediately.
  useChatStore.getState().setStreamingText(sessionKey, null)
}
