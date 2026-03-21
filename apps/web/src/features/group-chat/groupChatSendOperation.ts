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
import { findSleepingAgents, markAgentAwake, clearAllWakeRecords } from '@/lib/wakeTracker'
import { parseMention } from './parseMention'

// ─── Auto-wake tracking ──────────────────────────────────────────────────────
// In-memory guard preventing concurrent double-wake within a tab.
// Actual persistence is handled by wakeTracker (localStorage).

const wakeInFlight = new Set<string>()

/** Clear wakeup tracking — exposed for testing. */
export function resetWakeState(): void {
  wakeInFlight.clear()
  clearAllWakeRecords()
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
 * Best-effort Gateway verification: check which agents already have team sessions.
 * Returns agentIds confirmed as having active team sessions.
 */
async function verifyAgentSessions(
  client: GatewayClientLike,
  agentIds: string[],
  teamId: string,
): Promise<Set<string>> {
  const confirmed = new Set<string>()
  const checks = agentIds.map(async (id) => {
    try {
      const sessions = await client.call<{ key: string }[]>('sessions.list', { agentId: id })
      const teamSk = buildTeamSessionKey(id, teamId)
      if (Array.isArray(sessions) && sessions.some((s) => s.key === teamSk)) {
        confirmed.add(id)
        markAgentAwake(id, teamId)
      }
    } catch {
      // Gateway error — trust localStorage fallback
    }
  })
  // 3s timeout to avoid blocking the user's message indefinitely
  await Promise.race([Promise.allSettled(checks), new Promise((r) => setTimeout(r, 3000))])
  return confirmed
}

/**
 * Send a brief initialization message to specific team agents
 * using team-scoped sessionKeys so that their sessions exist on the Gateway
 * for inter-agent delegation. Uses raw client.call (not sendChatMessage) to
 * avoid creating optimistic user entries in the store.
 */
async function wakeTeamAgents(
  client: GatewayClientLike,
  agents: AgentState[],
  agentIdsToWake: string[],
  teamId: string,
  targetTeamSessionKey: string,
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

  // Wake only the agents that need it (determined by caller).
  const toWakeSet = new Set(agentIdsToWake)
  const toWake = agents.filter((a) => toWakeSet.has(a.id))

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
      .then(() => {
        markAgentAwake(agent.id, teamId)
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

  // ── Auto-wake agents that don't have active team sessions ─────────────────
  if (!wakeInFlight.has(teamId)) {
    const nonTargetIds = teamAgents.filter((a) => a.id !== targetId).map((a) => a.id)
    const sleeping = findSleepingAgents(nonTargetIds, teamId)

    if (sleeping.length > 0) {
      wakeInFlight.add(teamId)
      try {
        // Best-effort Gateway verification — skip agents already confirmed active
        const confirmed = await verifyAgentSessions(client, sleeping, teamId)
        const needsWake = sleeping.filter((id) => !confirmed.has(id))

        if (needsWake.length > 0) {
          await wakeTeamAgents(client, teamAgents, needsWake, teamId, targetTeamSk)
          // Settle delay — let agents initialize before actual message
          await new Promise((r) => setTimeout(r, WAKEUP_SETTLE_MS))
        }
      } finally {
        wakeInFlight.delete(teamId)
      }
    }
  }

  await sendChatMessage({
    client,
    agentId: target.id,
    sessionKey: targetTeamSk,
    message: mentionedId ? cleanedMessage : message,
    displayText,
  })
}
