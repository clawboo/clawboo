// Group chat send operation — routes messages to the correct team agent.
// Includes auto-wake: on first message, initializes all team agent sessions
// so that inter-agent delegation via sessions_send works.
// Uses team-scoped sessionKeys (agent:<id>:team:<teamId>) to isolate
// group chat transcripts from 1:1 agent chat.

import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { sendChatMessage } from '@/features/chat/chatSendOperation'
import { buildTeamSessionKey, setTeamChatOverride } from '@/lib/sessionUtils'
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
  "Hey! You've just joined a team collaboration session. Please briefly introduce yourself — share your name and what you specialize in, in one friendly sentence."

/** Delay after wakeup to let agents initialize before sending actual message. */
const WAKEUP_SETTLE_MS = 5000

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
 * using team-scoped sessionKeys so that their sessions exist on the Gateway
 * for inter-agent delegation. Uses raw client.call (not sendChatMessage) to
 * avoid creating optimistic user entries in the store.
 */
async function wakeTeamAgents(
  client: GatewayClientLike,
  agents: AgentState[],
  teamId: string,
  targetTeamSessionKey: string,
  skipAgentId: string,
): Promise<void> {
  // Append a meta notification to the target's team transcript so it appears
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
    sessionKey: targetTeamSessionKey,
  }
  useChatStore.getState().appendTranscript(targetTeamSessionKey, [metaEntry])

  // Wake all agents except the target (who will get the actual message).
  // Uses team-scoped sessionKeys so wakeup goes to the team session, not 1:1.
  const toWake = agents.filter((a) => a.id !== skipAgentId)

  const wakeups = toWake.map((agent) => {
    const agentTeamSk = buildTeamSessionKey(agent.id, teamId)
    // Set override so Gateway events (which use main sessionKey) get redirected
    setTeamChatOverride(agent.id, agentTeamSk)
    return client
      .call('chat.send', {
        sessionKey: agentTeamSk,
        message: WAKEUP_MESSAGE,
        deliver: false,
        idempotencyKey: crypto.randomUUID(),
      })
      .catch(() => {}) // non-fatal — one agent failing doesn't block others
  })

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
  if (!target) return

  // Compute team-scoped sessionKey for isolation from 1:1 chat
  const targetTeamSk = buildTeamSessionKey(target.id, teamId)

  // Set override so Gateway events (which use main sessionKey) get redirected
  // to the team session. Must be set BEFORE sending so events are captured.
  setTeamChatOverride(target.id, targetTeamSk)

  // ── Auto-wake all team agents on first group message ──────────────────────
  if (!wokenTeams.has(teamId)) {
    wokenTeams.add(teamId) // Mark BEFORE await to prevent concurrent double-wake
    await wakeTeamAgents(client, teamAgents, teamId, targetTeamSk, targetId)
    // Settle delay — let agents initialize before leader receives the actual message
    await new Promise((r) => setTimeout(r, WAKEUP_SETTLE_MS))
  }

  await sendChatMessage({
    client,
    agentId: target.id,
    sessionKey: targetTeamSk,
    message: mentionedId ? cleanedMessage : message,
    displayText,
  })
}
