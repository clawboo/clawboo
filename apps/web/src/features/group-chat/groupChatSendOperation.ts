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
import { buildTeamContextPreamble, type TeamContextEntry } from '@/lib/teamProtocol'
import { nextSeq } from '@/lib/sequenceKey'
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

/** Delay after wakeup to let agents initialize before sending actual message. */
const WAKEUP_SETTLE_MS = 5000

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GroupChatSendParams {
  client: GatewayClientLike
  teamId: string
  teamName: string
  leaderAgentId: string | null
  teamAgents: AgentState[]
  message: string
  /** Original message with @mention for display in transcript. */
  displayText?: string
  /**
   * User self-introduction captured during onboarding. When present, it's
   * injected into the team context preamble on every message so the agent
   * always knows who they're talking to. Source of truth lives in SQLite
   * (per-team settings: `team-onboarding:<teamId>.userIntroText`).
   */
  userIntroText?: string
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
  teamName: string,
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
    // Strictly-increasing tiebreaker (see lib/sequenceKey.ts).
    sequenceKey: nextSeq(),
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

    // Silent re-initialization message — does NOT ask for introductions or list
    // teammates as @mentions. The full team protocol (roster + anti-sub-agent
    // instructions) lives in AGENTS.md, which is loaded on every interaction.
    // Asking for introductions here would trigger the message-flooding cascade
    // (intros contain @mentions → false delegations → relay → more intros).
    const wakeMessage = `You are resuming a team collaboration session as ${agent.name} on team "${teamName}". Acknowledge silently — no introduction needed.`

    return client
      .call('chat.send', {
        sessionKey: agentTeamSk,
        message: wakeMessage,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read all team transcripts from the chat store and merge into
 * TeamContextEntry[] for buildTeamContextPreamble.
 */
export function getMergedTeamEntries(teamId: string, teamAgents: AgentState[]): TeamContextEntry[] {
  const transcripts = useChatStore.getState().transcripts
  const entries: TeamContextEntry[] = []

  for (const agent of teamAgents) {
    const teamSk = buildTeamSessionKey(agent.id, teamId)
    const transcript = transcripts.get(teamSk)
    if (!transcript) continue
    for (const e of transcript) {
      entries.push({
        agentName: agent.name,
        text: e.text,
        timestampMs: e.timestampMs ?? 0,
        kind: e.kind,
        role: e.role,
      })
    }
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs)
  return entries
}

// ─── Main operation ──────────────────────────────────────────────────────────

export async function sendGroupChatMessage(params: GroupChatSendParams): Promise<void> {
  const {
    client,
    teamId,
    teamName,
    leaderAgentId,
    teamAgents,
    message,
    displayText,
    userIntroText,
  } = params

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
          await wakeTeamAgents(client, teamAgents, needsWake, teamId, teamName, targetTeamSk)
          // Settle delay — let agents initialize before actual message
          await new Promise((r) => setTimeout(r, WAKEUP_SETTLE_MS))
        }
      } finally {
        wakeInFlight.delete(teamId)
      }
    }
  }

  // ── Build context preamble for target agent ──────────────────────────────
  // Always inject the user intro (if available) so the agent knows who
  // they're talking to on every message — Gateway SOUL.md persistence is
  // unreliable, so the preamble is the actual delivery mechanism.
  const contextEntries = getMergedTeamEntries(teamId, teamAgents)
  const preamble = buildTeamContextPreamble({
    entries: contextEntries,
    targetAgentName: target.name,
    userIntroText,
  })

  const messageToSend = mentionedId ? cleanedMessage : message
  const messageWithContext = preamble ? `${preamble}\n\n${messageToSend}` : messageToSend

  await sendChatMessage({
    client,
    agentId: target.id,
    sessionKey: targetTeamSk,
    message: messageWithContext,
    displayText,
  })
}
