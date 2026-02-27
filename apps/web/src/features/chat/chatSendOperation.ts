// Chat send operation — optimistic user entry, marks agent running, reverts on failure.

import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useChatStore } from '@/stores/chat'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendChatParams = {
  /** Connected gateway client. */
  client: GatewayClientLike
  agentId: string
  sessionKey: string
  message: string
  /** Injected for testing; defaults to `crypto.randomUUID`. */
  generateId?: () => string
  /** Injected for testing; defaults to `Date.now`. */
  now?: () => number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(
  override: Partial<TranscriptEntry> &
    Pick<TranscriptEntry, 'kind' | 'role' | 'text' | 'sessionKey'>,
  id: string,
  ts: number,
): TranscriptEntry {
  return {
    entryId: id,
    runId: null,
    source: 'local-send',
    timestampMs: ts,
    sequenceKey: ts,
    confirmed: false,
    fingerprint: id,
    ...override,
  }
}

// ─── Operation ────────────────────────────────────────────────────────────────

/**
 * Sends a chat message via the gateway and updates the Zustand stores.
 *
 * 1. Appends an optimistic user TranscriptEntry to the chat store.
 * 2. Marks the agent as 'running' in the fleet store.
 * 3. Calls `chat.send` on the gateway.
 * 4. On error: reverts status to 'error' and appends an error entry.
 */
export async function sendChatMessage({
  client,
  agentId,
  sessionKey,
  message,
  generateId = () => crypto.randomUUID(),
  now = () => Date.now(),
}: SendChatParams): Promise<void> {
  const trimmed = message.trim()
  if (!trimmed) return

  const ts = now()
  const idempotencyKey = generateId()

  // ── Optimistic user message ─────────────────────────────────────────────────
  const userEntry = makeEntry(
    { kind: 'user', role: 'user', text: trimmed, sessionKey },
    idempotencyKey,
    ts,
  )
  useChatStore.getState().appendTranscript(sessionKey, [userEntry])
  useFleetStore.getState().updateAgentStatus(agentId, 'running')

  // Persist user message to SQLite (best-effort)
  const gwUrl = useConnectionStore.getState().gatewayUrl ?? ''
  void fetch('/api/chat-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey, gatewayUrl: gwUrl, entries: [userEntry] }),
  }).catch(() => {})

  // ── Gateway call ────────────────────────────────────────────────────────────
  try {
    await client.call('chat.send', {
      sessionKey,
      message: trimmed,
      deliver: false,
      idempotencyKey,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Gateway error'
    const errorId = generateId()
    const errorEntry = makeEntry(
      {
        kind: 'meta',
        role: 'system',
        text: `Error: ${errMsg}`,
        sessionKey,
        confirmed: true,
      },
      errorId,
      now(),
    )
    useChatStore.getState().appendTranscript(sessionKey, [errorEntry])
    useFleetStore.getState().updateAgentStatus(agentId, 'error')
  }
}
