// Team orchestration hook — watches team transcripts for delegation
// patterns and relay triggers. Runs as a background watcher with
// no useState (ref-only) to avoid unnecessary re-renders.

import { useEffect, useRef } from 'react'
import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { buildTeamSessionKey, setTeamChatOverride, hasTeamChatOverride } from '@/lib/sessionUtils'
import { buildTeamContextPreamble, buildTeamWakeMessage } from '@/lib/teamProtocol'
import { isAgentAwake } from '@/lib/wakeTracker'
import { detectDelegations, isRelayMessage } from './delegationDetector'
import {
  buildRelayMessage,
  determineRelayTargets,
  shouldRelay,
  recordRelay,
  getOrCreateTeamRelayState,
  getRelayDepth,
  incrementRelayDepth,
  DEFAULT_RELAY_CONFIG,
} from './contextRelay'
import { getMergedTeamEntries } from './groupChatSendOperation'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseTeamOrchestrationParams {
  teamId: string | null
  teamAgents: AgentState[]
  /**
   * The team-internal lead (CTO, Team Lead, etc., detected via
   * `detectGenuineLeader` at deploy time). May be null when the team has
   * no genuine leader role. Only used as a relay-hub fallback when Boo
   * Zero is unavailable.
   */
  leaderAgentId: string | null
  /**
   * Boo Zero — the universal team leader. When present, Boo Zero is the
   * relay hub: every teammate's response gets relayed to Boo Zero, and
   * Boo Zero's own `<delegate>` blocks get routed to teammates.
   */
  booZeroAgent?: AgentState | null
  client: GatewayClientLike | null
  enabled?: boolean
  /**
   * User self-introduction captured during onboarding. Injected into the
   * delegation preamble so the target agent knows who the user is, even when
   * the delegation is routed agent-to-agent (without a fresh user message).
   */
  userIntroText?: string
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useTeamOrchestration(params: UseTeamOrchestrationParams): void {
  const { teamId, enabled = true } = params

  // Keep latest params in refs so the subscribe callback sees current values
  // without needing to tear down / recreate the subscription.
  const teamAgentsRef = useRef(params.teamAgents)
  teamAgentsRef.current = params.teamAgents
  const leaderAgentIdRef = useRef(params.leaderAgentId)
  leaderAgentIdRef.current = params.leaderAgentId
  const booZeroAgentRef = useRef(params.booZeroAgent ?? null)
  booZeroAgentRef.current = params.booZeroAgent ?? null
  const clientRef = useRef(params.client)
  clientRef.current = params.client
  const teamIdRef = useRef(teamId)
  teamIdRef.current = teamId
  const userIntroTextRef = useRef(params.userIntroText)
  userIntroTextRef.current = params.userIntroText

  // Tracking state (all refs — no re-renders)
  const lastCountsRef = useRef<Map<string, number>>(new Map())
  const delegationSourceRef = useRef<Map<string, string>>(new Map()) // targetAgentId → sourceAgentId
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled || !teamId) return

    const processNewEntries = () => {
      const currentTeamId = teamIdRef.current
      const currentClient = clientRef.current
      const currentTeamMembers = teamAgentsRef.current
      const currentInternalLead = leaderAgentIdRef.current
      const currentBooZero = booZeroAgentRef.current
      // "Effective participants" = team members + Boo Zero. Boo Zero's
      // assistant entries can contain `<delegate>` blocks too, so we have
      // to scan its transcript for delegation patterns; and the delegation
      // target may be any participant (including Boo Zero).
      const currentAgents = currentBooZero
        ? [...currentTeamMembers, currentBooZero]
        : currentTeamMembers
      if (!currentTeamId || !currentClient || currentAgents.length === 0) return
      // Relay hub: Boo Zero (when available) — every teammate's response is
      // relayed to Boo Zero so the universal leader stays in the loop. Fall
      // back to the team-internal lead when Boo Zero is unavailable.
      const relayHubId = currentBooZero?.id ?? currentInternalLead

      const transcripts = useChatStore.getState().transcripts
      const lastCounts = lastCountsRef.current

      for (const agent of currentAgents) {
        const teamSk = buildTeamSessionKey(agent.id, currentTeamId)
        const entries = transcripts.get(teamSk)
        if (!entries) continue

        const prevCount = lastCounts.get(teamSk) ?? 0
        if (entries.length <= prevCount) continue

        // Process only new entries since last check
        const newEntries = entries.slice(prevCount)
        lastCounts.set(teamSk, entries.length)

        for (const entry of newEntries) {
          if (entry.role !== 'assistant' || entry.kind !== 'assistant') continue

          const text = entry.text
          if (!text || isRelayMessage(text)) continue

          const sourceAgentId = agent.id

          // ── Delegation detection ──────────────────────────────
          const delegations = detectDelegations(
            text,
            sourceAgentId,
            currentAgents.map((a) => ({ id: a.id, name: a.name })),
          )

          for (const delegation of delegations) {
            const sendDelegation = async (retryCount = 0) => {
              try {
                // Guard: target agent may have been deleted during processing.
                // The target may be Boo Zero — check both team members AND
                // Boo Zero (Boo Zero is teamless so not in `teamAgentsRef`).
                const freshTeamMembers = teamAgentsRef.current
                const freshBooZero = booZeroAgentRef.current
                const freshParticipants = freshBooZero
                  ? [...freshTeamMembers, freshBooZero]
                  : freshTeamMembers
                if (!freshParticipants.some((a) => a.id === delegation.targetAgentId)) return

                // Guard: target is already processing a team message — retry once after 2s
                if (hasTeamChatOverride(delegation.targetAgentId)) {
                  if (retryCount < 1) {
                    setTimeout(() => void sendDelegation(retryCount + 1), 2000)
                  }
                  return
                }

                const targetTeamSk = buildTeamSessionKey(delegation.targetAgentId, currentTeamId)

                // Set override BEFORE sending so Gateway events get redirected
                setTeamChatOverride(delegation.targetAgentId, targetTeamSk)

                // Build context preamble from merged transcript — also injects
                // the user intro so the target agent knows who the user is
                // (delegations are agent-to-agent, no fresh user message).
                // Pass team members + Boo Zero as separate args so the merge
                // includes Boo Zero's transcript without double-counting.
                const contextEntries = getMergedTeamEntries(
                  currentTeamId,
                  freshTeamMembers,
                  freshBooZero,
                )
                const targetAgent = freshParticipants.find((a) => a.id === delegation.targetAgentId)
                const preamble = buildTeamContextPreamble({
                  entries: contextEntries,
                  targetAgentName: targetAgent?.name ?? '',
                  userIntroText: userIntroTextRef.current,
                })

                const messageBody = preamble
                  ? `${preamble}\n\n${delegation.taskDescription}`
                  : delegation.taskDescription

                await currentClient.call('chat.send', {
                  sessionKey: targetTeamSk,
                  message: messageBody,
                  deliver: false,
                  idempotencyKey: crypto.randomUUID(),
                })

                // Track delegation source for relay routing
                delegationSourceRef.current.set(delegation.targetAgentId, sourceAgentId)
              } catch {
                // Non-fatal — delegation failure doesn't block other processing
              }
            }
            void sendDelegation()
          }

          // ── Context relay ──────────────────────────────────────
          const relayState = getOrCreateTeamRelayState(currentTeamId)
          const lastRelayAt = relayState.lastRelayAt.get(sourceAgentId)

          if (
            shouldRelay({
              responseText: text,
              config: DEFAULT_RELAY_CONFIG,
              relayDepth: getRelayDepth(currentTeamId, sourceAgentId),
              lastRelayAt,
            })
          ) {
            const delegationSource = delegationSourceRef.current.get(sourceAgentId)
            const targets = determineRelayTargets({
              respondingAgentId: sourceAgentId,
              teamAgents: currentAgents.map((a) => ({ id: a.id, name: a.name })),
              leaderAgentId: relayHubId,
              delegationSourceId: delegationSource,
            })

            const relayMsg = buildRelayMessage({
              fromAgentName: agent.name,
              responseText: text,
              maxChars: DEFAULT_RELAY_CONFIG.maxSummaryChars,
            })

            for (const targetId of targets) {
              void (async () => {
                try {
                  // Guard: target agent may have been deleted during processing.
                  // Relay targets can include Boo Zero — check both team members
                  // and (when present) Boo Zero before bailing out.
                  const freshTeamMembers = teamAgentsRef.current
                  const freshBooZero = booZeroAgentRef.current
                  const targetAgent =
                    freshTeamMembers.find((a) => a.id === targetId) ??
                    (freshBooZero && freshBooZero.id === targetId ? freshBooZero : null)
                  if (!targetAgent) return

                  const targetTeamSk = buildTeamSessionKey(targetId, currentTeamId)

                  // Wake sleeping agent before relaying (best-effort)
                  if (!isAgentAwake(targetId, currentTeamId)) {
                    const teammatesPool = freshBooZero
                      ? [...freshTeamMembers, freshBooZero]
                      : freshTeamMembers
                    const teammates = teammatesPool
                      .filter((a) => a.id !== targetId)
                      .map((a) => ({ name: a.name, role: a.name }))
                    const wakeMsg = buildTeamWakeMessage({
                      agentName: targetAgent.name,
                      teamName: currentTeamId, // best-effort — teamName not available here
                      teammates,
                    })
                    setTeamChatOverride(targetId, targetTeamSk)
                    await currentClient.call('chat.send', {
                      sessionKey: targetTeamSk,
                      message: wakeMsg,
                      deliver: false,
                      idempotencyKey: crypto.randomUUID(),
                    })
                    await new Promise((r) => setTimeout(r, 5000))
                  }

                  setTeamChatOverride(targetId, targetTeamSk)

                  await currentClient.call('chat.send', {
                    sessionKey: targetTeamSk,
                    message: relayMsg,
                    deliver: false,
                    idempotencyKey: crypto.randomUUID(),
                  })
                } catch {
                  // Non-fatal
                }
              })()
            }

            recordRelay(currentTeamId, sourceAgentId)
            incrementRelayDepth(currentTeamId, sourceAgentId)
            // Clean up delegation source after relay is sent
            delegationSourceRef.current.delete(sourceAgentId)
          }
        }
      }
    }

    // Initialize lastCounts with current state to avoid processing historical
    // entries. Include Boo Zero's team-scoped session so its older messages
    // aren't re-scanned for delegations on mount.
    const transcripts = useChatStore.getState().transcripts
    const seedAgents = params.booZeroAgent
      ? [...params.teamAgents, params.booZeroAgent]
      : params.teamAgents
    for (const agent of seedAgents) {
      const teamSk = buildTeamSessionKey(agent.id, teamId)
      const entries = transcripts.get(teamSk)
      lastCountsRef.current.set(teamSk, entries?.length ?? 0)
    }

    // Subscribe to chat store changes with debounce
    const unsub = useChatStore.subscribe(() => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        processNewEntries()
      }, 500)
    })

    return () => {
      unsub()
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [enabled, teamId]) // Intentionally minimal deps — refs carry current values
}
