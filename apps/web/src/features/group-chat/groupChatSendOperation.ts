// Group chat send operation — routes messages to the correct team agent.
// Includes auto-wake: on first message, initializes all team agent sessions
// so that inter-agent delegation via sessions_send works.

import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { sendChatMessage } from '@/features/chat/chatSendOperation'
import { parseMention } from './parseMention'

// ─── Auto-wake tracking ──────────────────────────────────────────────────────
// Module-level Set tracking which teams have been woken up this session.
// Resets on page refresh — fine because Gateway sessions persist across reloads.

const wokenTeams = new Set<string>()

/** Clear wakeup tracking — exposed for testing. */
export function resetWokenTeams(): void {
  wokenTeams.clear()
}

const WAKEUP_MESSAGE =
  'You are now active in team collaboration mode. Await @mentions or delegated tasks. Keep this acknowledgment brief — one sentence max.'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GroupChatSendParams {
  client: GatewayClientLike
  teamId: string
  leaderAgentId: string | null
  teamAgents: AgentState[]
  message: string
  /** Original message with @mention for display in transcript. */
  displayText?: string
}

// ─── Wakeup ──────────────────────────────────────────────────────────────────

/**
 * Send a brief initialization message to all team agents (except the target)
 * so that their sessions exist on the Gateway for inter-agent delegation.
 * Uses raw client.call (not sendChatMessage) to avoid creating optimistic
 * user entries in the store.
 */
async function wakeTeamAgents(
  client: GatewayClientLike,
  agents: AgentState[],
  targetSessionKey: string,
  skipAgentId: string,
): Promise<void> {
  // Append a meta notification to the target's transcript so it appears
  // in the group chat merge just before the user's actual message.
  const ts = Date.now()
  const metaEntry: TranscriptEntry = {
    entryId: crypto.randomUUID(),
    runId: null,
    source: 'local-send',
    timestampMs: ts,
    sequenceKey: ts,
    confirmed: true,
    fingerprint: crypto.randomUUID(),
    kind: 'meta',
    role: 'system',
    text: 'Initializing team agents for collaboration...',
    sessionKey: targetSessionKey,
  }
  useChatStore.getState().appendTranscript(targetSessionKey, [metaEntry])

  // Wake all agents except the target (who will get the actual message)
  const toWake = agents.filter((a) => a.id !== skipAgentId && a.sessionKey)

  const wakeups = toWake.map(
    (agent) =>
      client
        .call('chat.send', {
          sessionKey: agent.sessionKey,
          message: WAKEUP_MESSAGE,
          deliver: false,
          idempotencyKey: crypto.randomUUID(),
        })
        .catch(() => {}), // non-fatal — one agent failing doesn't block others
  )

  await Promise.allSettled(wakeups)
}

// ─── Main operation ──────────────────────────────────────────────────────────

export async function sendGroupChatMessage(params: GroupChatSendParams): Promise<void> {
  const { client, teamId, leaderAgentId, teamAgents, message, displayText } = params

  // Parse @mention to determine target agent
  const { targetAgentId: mentionedId, cleanedMessage } = parseMention(
    message,
    teamAgents.map((a) => ({ id: a.id, name: a.name })),
  )

  // Resolve target: @mentioned > leader > first team agent
  const targetId = mentionedId ?? leaderAgentId ?? teamAgents[0]?.id
  if (!targetId) return

  const target = teamAgents.find((a) => a.id === targetId)
  if (!target?.sessionKey) return

  // ── Auto-wake all team agents on first group message ──────────────────────
  if (!wokenTeams.has(teamId)) {
    wokenTeams.add(teamId) // Mark BEFORE await to prevent concurrent double-wake
    await wakeTeamAgents(client, teamAgents, target.sessionKey, targetId)
  }

  await sendChatMessage({
    client,
    agentId: target.id,
    sessionKey: target.sessionKey,
    message: mentionedId ? cleanedMessage : message,
    displayText,
  })
}
