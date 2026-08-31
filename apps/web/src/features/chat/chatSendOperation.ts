// Chat send operation — optimistic user entry, marks agent running, reverts on failure.

import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { TranscriptEntry } from '@clawboo/protocol'
import { apiFetch } from '@clawboo/control-client'
import { archiveConversation, isResetCommand, RESET_NOTICE } from './resetConversation'
import { useChatStore } from '@/stores/chat'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { resolveExecPatchParams, upsertExecApprovalPolicy } from '@/lib/execSettingsForGateway'
import { nextSeq } from '@/lib/sequenceKey'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendChatParams = {
  /** Connected gateway client. */
  client: GatewayClientLike
  agentId: string
  sessionKey: string
  message: string
  /** Original message with @mention for display in transcript. Falls back to `message`. */
  displayText?: string
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
    // Strictly-increasing tiebreaker for the merged-transcript sort.
    // Using `ts` here would make sequenceKey === timestampMs, so the
    // comparator could never break ties for entries that landed in the
    // same millisecond. See lib/sequenceKey.ts.
    sequenceKey: nextSeq(),
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
  displayText,
  generateId = () => crypto.randomUUID(),
  now = () => Date.now(),
}: SendChatParams): Promise<void> {
  const trimmed = message.trim()
  if (!trimmed) return

  // ── Start a fresh conversation ─────────────────────────────────────────────
  // The chat stays on the key it is already on. The command goes through to the
  // runtime, which is what actually ends the conversation the model is holding:
  // clearing only our side would leave the model answering from turns the person
  // can no longer see. See resetConversation.ts for what this replaced.
  if (isResetCommand(trimmed)) {
    await archiveConversation(sessionKey)
    useFleetStore.setState((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, streamingText: null, runId: null } : a,
      ),
    }))

    let text = RESET_NOTICE
    try {
      await client.call('chat.send', {
        sessionKey,
        message: trimmed,
        deliver: false,
        idempotencyKey: generateId(),
      })
    } catch {
      // The screen is clear but the model is not. Say so, because the difference
      // is visible the moment it answers from something the person cannot see.
      text =
        'Your conversation is saved and the chat is clear, but the agent could not be reached, so it may still remember the earlier messages.'
    }
    const resetEntry = makeEntry(
      { kind: 'meta', role: 'system', text, sessionKey, confirmed: true },
      generateId(),
      now(),
    )
    useChatStore.getState().appendTranscript(sessionKey, [resetEntry])
    return
  }

  const ts = now()
  const idempotencyKey = generateId()

  // ── Optimistic user message ─────────────────────────────────────────────────
  const userEntry = makeEntry(
    { kind: 'user', role: 'user', text: displayText?.trim() || trimmed, sessionKey },
    idempotencyKey,
    ts,
  )
  useChatStore.getState().appendTranscript(sessionKey, [userEntry])
  useFleetStore.getState().updateAgentStatus(agentId, 'running')

  // Persist user message to SQLite (best-effort)
  const gwUrl = useConnectionStore.getState().gatewayUrl ?? ''
  void apiFetch('/api/chat-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey, gatewayUrl: gwUrl, entries: [userEntry] }),
  }).catch(() => {})

  // ── Apply per-agent model + exec settings if set ─────────────────────────
  const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
  if (agent?.model) {
    try {
      await client.call('sessions.patch', { key: sessionKey, model: agent.model })
    } catch {
      // Non-fatal: model may already be set or Gateway may not support sessions.patch
    }
  }
  if (agent?.execConfig) {
    // 1. Write per-agent approval policy (best-effort — enables approval events)
    try {
      await upsertExecApprovalPolicy(client, agentId, agent.execConfig.execAsk)
    } catch {
      // Non-fatal — policy may already be set from ExecSettings
    }

    // 2. Patch the live session with exec settings
    try {
      const execParams = resolveExecPatchParams(agent.execConfig.execAsk)
      await client.call('sessions.patch', {
        key: sessionKey,
        ...execParams,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      useToastStore.getState().addToast({
        message: `Failed to apply execution permissions: ${msg}`,
        type: 'error',
      })
    }
  }

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
