// Group chat send operation — routes messages to the correct team agent.
// Includes auto-wake: on first message, initializes all team agent sessions
// so that inter-agent delegation via sessions_send works.
// Uses team-scoped sessionKeys (agent:<id>:team:<teamId>) to isolate
// group chat transcripts from 1:1 agent chat.

import type { GatewayClientLike } from '@clawboo/gateway-client'
import { listAgentSessions } from '@/lib/agentSourceClient'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { sendChatMessage } from '@/features/chat/chatSendOperation'
import { buildTeamSessionKey, setTeamChatOverride } from '@/lib/sessionUtils'
import { findSleepingAgents, markAgentAwake, clearAllWakeRecords } from '@/lib/wakeTracker'
import {
  buildSilentResumeWakeMessage,
  buildTeamContextPreamble,
  type TeamContextEntry,
} from '@/lib/teamProtocol'
import { buildBooZeroRulesBlock } from '@/lib/booZeroRules'
import { buildTeamRulesBlock, fetchTeamRules } from '@/lib/teamRules'
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

/**
 * Drop the in-flight-wake guard for a specific team. Called when the user
 * presses Stop on the team chat — without this, the `wakeInFlight.has(teamId)`
 * check in `sendGroupChatMessage` would block the NEXT user message from
 * waking agents (until the guard naturally cleared via the existing
 * `wakeInFlight.delete` calls along the wake path, which won't run because
 * the wake was aborted mid-flight). Idempotent.
 */
export function clearWakeInFlight(teamId: string): void {
  wakeInFlight.delete(teamId)
}

/** Delay after wakeup to let agents initialize before sending actual message. */
const WAKEUP_SETTLE_MS = 5000

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GroupChatSendParams {
  client: GatewayClientLike
  teamId: string
  teamName: string
  /**
   * The team-internal lead (CTO, Team Lead, etc.) — under Boo Zero. May be
   * null when no genuine leader role was detected in the team. Only used as
   * a routing fallback when Boo Zero is missing.
   */
  leaderAgentId: string | null
  teamAgents: AgentState[]
  /**
   * Boo Zero, the universal team leader. When present, this is the default
   * routing target for messages without an explicit `@mention`. Boo Zero is
   * teamless (`teamId === null`) but participates in every team's chat via
   * its team-scoped sessionKey: `agent:<booZeroId>:team:<teamId>`.
   */
  booZeroAgent?: AgentState | null
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
async function verifyAgentSessions(agentIds: string[], teamId: string): Promise<Set<string>> {
  const confirmed = new Set<string>()
  const checks = agentIds.map(async (id) => {
    try {
      const sessions = await listAgentSessions(id)
      const teamSk = buildTeamSessionKey(id, teamId)
      if (sessions.some((s) => s.sourceSessionId === teamSk)) {
        confirmed.add(id)
        markAgentAwake(id, teamId)
      }
    } catch {
      // Source/Gateway error — trust localStorage fallback
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
  /**
   * Boo Zero agent reference — when one of the agents being woken IS Boo
   * Zero, we MUST prefix its wake message with `buildBooZeroRulesBlock` so
   * the LLM has its identity + behavioral rules in context. The 7-hour
   * cascade in production happened because Boo Zero's wake messages had
   * neither identity nor rules — the LLM defaulted to "Mythos" and
   * produced unsolicited greetings. Team-member wakes don't need this
   * (their AGENTS.md carries the rules).
   */
  booZeroAgent: AgentState | null,
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

    // Structural resume wake — asks the agent to reply with EXACTLY
    // `__resumed__` and nothing else. The literal-token contract is more
    // reliable than prose "stay quiet" instructions. Pairs with the
    // AGENTS.md "Resuming sessions" rule for team members and the Boo
    // Zero rules block injected below for the leader. The UI filters
    // `__resumed__` entries out of the merged transcript so they never
    // pollute the visible chat.
    const baseWake = buildSilentResumeWakeMessage({
      agentName: agent.name,
      teamName,
    })

    // When the agent being woken IS Boo Zero, prefix with the rules block so
    // the LLM has its identity + behavioral rules in context. Without this
    // the 08:18 AM production cascade fires: Boo Zero's wake produces
    // unsolicited intros + name drift ("Mythos"). Team-member wakes already
    // carry the rules via their team AGENTS.md so they don't need this
    // injection.
    const isBooZeroWake = booZeroAgent !== null && agent.id === booZeroAgent.id
    const wakeMessage = isBooZeroWake
      ? `${buildBooZeroRulesBlock({ displayName: agent.name, teamName })}\n\n${baseWake}`
      : baseWake

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
 * `TeamContextEntry[]` for `buildTeamContextPreamble`.
 *
 * When `booZeroAgent` is provided, its team-scoped session for this team is
 * also merged in — Boo Zero is the universal team leader and its own
 * contributions to the team's conversation belong in the merged context.
 *
 * `booZeroAgent` is intentionally separate from `teamAgents` (which is
 * filtered by `agents.teamId === teamId`) because Boo Zero stays teamless
 * in the DB.
 */
export function getMergedTeamEntries(
  teamId: string,
  teamAgents: AgentState[],
  booZeroAgent?: AgentState | null,
): TeamContextEntry[] {
  const transcripts = useChatStore.getState().transcripts
  const entries: TeamContextEntry[] = []
  // Dedup by id defensively — see the same rationale in `GroupChatPanel.tsx`.
  // If Boo Zero is somehow already in `teamAgents` we'd otherwise pull its
  // transcript twice and feed duplicate context into preambles.
  const combined = booZeroAgent ? [...teamAgents, booZeroAgent] : teamAgents
  const seen = new Set<string>()
  const participants: AgentState[] = []
  for (const a of combined) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    participants.push(a)
  }

  for (const agent of participants) {
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

// ─── Identity anchor + rules block ────────────────────────────────────────────
// Boo Zero's identity AND its load-bearing behavioral rules ("delegate first,
// don't do work yourself, never use the Task tool, don't claim teammate
// timeouts, don't greet on resume") are baked into `buildBooZeroRulesBlock`.
// We inject it as the FIRST section of every Boo Zero turn — every code path
// that sends a message to Boo Zero MUST include this block. Production saw
// the LLM drift in all these dimensions when the rules weren't in context,
// so the per-turn injection is load-bearing for both the name and behavior.

// ─── Team brief fetch ────────────────────────────────────────────────────────
// Boo Zero reads the team brief on every message so it understands team
// dynamics. SQLite is the source of truth (`/api/boo-zero/team-briefs/:teamId`);
// when the brief is missing or the API errors, we fall through without it —
// Boo Zero's general behavior comes from its global brief + on-disk identity.

interface TeamBriefResponse {
  content?: string | null
}

async function fetchTeamBrief(teamId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/boo-zero/team-briefs/${encodeURIComponent(teamId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as TeamBriefResponse
    return typeof body.content === 'string' && body.content.length > 0 ? body.content : null
  } catch {
    return null
  }
}

/** Wraps the brief markdown in the structured envelope Boo Zero recognizes. */
function buildTeamBriefBlock(teamName: string, brief: string): string {
  return `[Team Brief: ${teamName}]\n${brief.trim()}\n[End Team Brief]`
}

// ─── Main operation ──────────────────────────────────────────────────────────

export async function sendGroupChatMessage(params: GroupChatSendParams): Promise<void> {
  const {
    client,
    teamId,
    teamName,
    leaderAgentId,
    teamAgents,
    booZeroAgent,
    message,
    displayText,
    userIntroText,
  } = params

  // Build the @-mention candidate list: team members + Boo Zero. The user can
  // address Boo Zero directly with `@<BooZero Name>` to force routing to it
  // even in a team chat.
  const mentionCandidates = booZeroAgent
    ? [...teamAgents, booZeroAgent].map((a) => ({ id: a.id, name: a.name }))
    : teamAgents.map((a) => ({ id: a.id, name: a.name }))

  const { targetAgentId: mentionedId, cleanedMessage } = parseMention(message, mentionCandidates)

  // Routing priority: @mention > Boo Zero (universal leader) > team-internal
  // lead > first team member. Boo Zero is the new no-mention default.
  const targetId = mentionedId ?? booZeroAgent?.id ?? leaderAgentId ?? teamAgents[0]?.id ?? null
  if (!targetId) return

  // Resolve the target. It may be a team member OR Boo Zero (which is not
  // in `teamAgents` because it's teamless).
  const target =
    teamAgents.find((a) => a.id === targetId) ??
    (booZeroAgent && booZeroAgent.id === targetId ? booZeroAgent : null)
  if (!target) return

  // Compute team-scoped sessionKey for isolation from 1:1 chat. Boo Zero
  // gets its own team-scoped session per team — same scheme.
  const targetTeamSk = buildTeamSessionKey(target.id, teamId)

  // Set override so Gateway events (which use main sessionKey) get redirected
  // to the team session. Must be set BEFORE sending so events are captured.
  // The override is pending until the first event with a runId promotes it.
  setTeamChatOverride(target.id, targetTeamSk)

  // ── Auto-wake agents that don't have active team sessions ─────────────────
  // Include Boo Zero in the wake set (when present) so its team-scoped
  // session exists on the Gateway — required for Boo Zero to receive
  // relays from teammates.
  if (!wakeInFlight.has(teamId)) {
    const wakeCandidates = booZeroAgent ? [...teamAgents, booZeroAgent] : teamAgents
    const nonTargetIds = wakeCandidates.filter((a) => a.id !== targetId).map((a) => a.id)
    const sleeping = findSleepingAgents(nonTargetIds, teamId)

    if (sleeping.length > 0) {
      wakeInFlight.add(teamId)
      try {
        // Best-effort Gateway verification — skip agents already confirmed active
        const confirmed = await verifyAgentSessions(sleeping, teamId)
        const needsWake = sleeping.filter((id) => !confirmed.has(id))

        if (needsWake.length > 0) {
          await wakeTeamAgents(
            client,
            wakeCandidates,
            needsWake,
            teamId,
            teamName,
            targetTeamSk,
            booZeroAgent ?? null,
          )
          // Settle delay — let agents initialize before actual message
          await new Promise((r) => setTimeout(r, WAKEUP_SETTLE_MS))
        }
      } finally {
        wakeInFlight.delete(teamId)
      }
    }
  }

  // ── Build context preamble for target agent ──────────────────────────────
  // Boo Zero's responses belong in the merged team context — include them
  // in the merge so when Boo Zero delegates to a teammate (or vice versa)
  // the recipient sees the full team conversation.
  const contextEntries = getMergedTeamEntries(teamId, teamAgents, booZeroAgent ?? undefined)
  const preamble = buildTeamContextPreamble({
    entries: contextEntries,
    targetAgentName: target.name,
    userIntroText,
  })

  // When the target is Boo Zero, ALSO fetch the team brief and prepend it.
  // The brief is Boo Zero's per-team operating manual — what the team does,
  // who its members are, who the internal lead is, anti-patterns. We only
  // ship it when targeting Boo Zero because team members already have their
  // own per-agent identity files. Best-effort — missing brief is silently OK.
  let briefBlock: string | null = null
  let rulesBlock: string | null = null
  if (booZeroAgent && target.id === booZeroAgent.id) {
    const brief = await fetchTeamBrief(teamId)
    if (brief) briefBlock = buildTeamBriefBlock(teamName, brief)

    // Boo Zero rules — load-bearing fix for identity drift + "doing work
    // yourself" + Task-tool reach + "claimed teammate timed out" + resume
    // greetings. The rules block fires on EVERY Boo Zero turn so the LLM
    // can never lose the constraint even after long pauses or many
    // turns. Lives in `lib/booZeroRules.ts`; user-uneditable by design.
    rulesBlock = buildBooZeroRulesBlock({
      displayName: booZeroAgent.name,
      teamName,
    })
  }

  // Team Rules — user-captured durable rules. Loaded for EVERY message in
  // the team chat (target may be a team member OR Boo Zero). This is what
  // makes user corrections survive across sessions: when the user types
  // `/rule don't do work yourself` it persists here and is injected on
  // every future turn even after a 7-hour gap.
  const teamRulesContent = await fetchTeamRules(teamId)
  const teamRulesBlock = buildTeamRulesBlock(teamRulesContent)

  const messageToSend = mentionedId ? cleanedMessage : message
  // Order matters: rules first (anchors who you are + how you must behave),
  // then team brief (anchors WHERE you are this turn), then team rules
  // (user-set authoritative constraints), then conversation preamble, then
  // the actual message.
  const sections = [rulesBlock, briefBlock, teamRulesBlock, preamble, messageToSend].filter(
    (s): s is string => Boolean(s),
  )
  const messageWithContext = sections.join('\n\n')

  await sendChatMessage({
    client,
    agentId: target.id,
    sessionKey: targetTeamSk,
    message: messageWithContext,
    displayText,
  })
}
