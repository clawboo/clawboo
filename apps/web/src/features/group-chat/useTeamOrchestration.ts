// Team orchestration hook — watches team transcripts for delegation
// patterns and relay triggers. Runs as a background watcher with
// no useState (ref-only) to avoid unnecessary re-renders.

import { useEffect, useRef } from 'react'
import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { AgentState } from '@/stores/fleet'
import { useChatStore } from '@/stores/chat'
import { buildTeamSessionKey, setTeamChatOverride, hasTeamChatOverride } from '@/lib/sessionUtils'
import { buildTeamContextPreamble, buildSilentResumeWakeMessage } from '@/lib/teamProtocol'
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

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Duration of the post-Stop freeze window (milliseconds). While inside the
 * window, `processNewEntries` skips delegation/relay scanning but still
 * advances `lastCountsRef` so post-freeze processing doesn't re-scan what
 * arrived during the freeze.
 *
 * Chosen as 3 s because:
 *   • The Gateway commits `chat.abort` partial responses within ~100 ms.
 *   • Fire-and-forget delegation IIFEs from a pre-stop batch finish their
 *     own `chat.send` round-trip in well under 1 s.
 *   • Cross-agent wake messages (`buildSilentResumeWakeMessage`) are
 *     instructed to "stay quiet" per `AGENTS.md`, so even if one slips
 *     through during the freeze its response normally contains no
 *     `<delegate>` blocks.
 * 3 s is comfortably past those windows without making the chat feel
 * frozen to the user. Tunable if real-world cascades exceed this.
 */
const STOP_FREEZE_MS = 3000

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseTeamOrchestrationParams {
  teamId: string | null
  /**
   * The team's display name. Threaded through here so the wake-on-relay
   * path can use it in the silent-resume message body. Without this, the
   * wake body used to read `team "<UUID>"` (raw team id) — a confusing
   * artifact of the original implementation.
   */
  teamName: string
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
  /**
   * Monotonic counter bumped by the parent (`GroupChatPanel`) when the
   * Stop button is pressed. On change, the hook cancels its pending 500ms
   * debounce timer AND resets its bookkeeping refs so no relay or
   * delegation fires for activity that was in flight at stop time. The
   * actual `chat.abort` RPCs are sent by `stopAllInTeam` separately —
   * this hook only owns the orchestration-side cleanup.
   */
  stopSignal?: number
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useTeamOrchestration(params: UseTeamOrchestrationParams): void {
  const { teamId, enabled = true, stopSignal = 0 } = params

  // Keep latest params in refs so the subscribe callback sees current values
  // without needing to tear down / recreate the subscription.
  const teamNameRef = useRef(params.teamName)
  teamNameRef.current = params.teamName
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
  /**
   * Per-batch wake dedup. When `processNewEntries` fires multiple relays
   * inside a single tick (e.g., Boo Zero delegates to 6 sleeping agents
   * and we relay back to the hub for each), we'd otherwise queue 6
   * back-to-back wake messages on the SAME hub. Track agents we've already
   * woken in this batch and skip subsequent wakes. The set is cleared at
   * the end of each batch.
   */
  const wokenThisBatchRef = useRef<Set<string>>(new Set())
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Post-stop freeze window ──────────────────────────────────────────────
  //
  // When the user presses Stop, we set this timestamp ~3 seconds into the
  // future. While `Date.now() < frozenUntilRef.current`, `processNewEntries`
  // skips delegation scanning AND skips relay scheduling — but still updates
  // `lastCountsRef` so that anything that arrives DURING the freeze is
  // treated as "already processed" once the freeze lifts. Catches the
  // common cascade triggers after Stop:
  //   • Partial-response commits from the in-flight runs that `chat.abort`
  //     was racing to cancel (the `"NO_RE"`, `"NO"` truncated messages).
  //   • Fire-and-forget delegation / relay IIFEs that were already queued
  //     from the pre-stop batch — their wake messages + subsequent agent
  //     responses land during the freeze and get silently absorbed.
  //   • Tail events from the Gateway for the aborted runs.
  // After the freeze, normal processing resumes — but `lastCountsRef` has
  // been kept current, so we don't re-scan the entries that arrived during
  // the freeze for delegations.
  const frozenUntilRef = useRef<number>(0)

  useEffect(() => {
    if (!enabled || !teamId) return

    const processNewEntries = () => {
      // Reset per-batch dedup set at the start of every batch so we never
      // permanently skip an agent's future wakes.
      wokenThisBatchRef.current = new Set<string>()
      const currentTeamId = teamIdRef.current
      const currentClient = clientRef.current
      const currentTeamMembers = teamAgentsRef.current
      const currentInternalLead = leaderAgentIdRef.current
      const currentBooZero = booZeroAgentRef.current
      // "Effective participants" = team members + Boo Zero, deduplicated by
      // agent id. Boo Zero's assistant entries can contain `<delegate>`
      // blocks too, so we have to scan its transcript for delegation
      // patterns; and the delegation target may be any participant
      // (including Boo Zero). Dedup defensively — if Boo Zero leaks into
      // `teamAgents` we'd otherwise double-process its transcript and
      // double-route its `<delegate>` blocks.
      const combinedAgents = currentBooZero
        ? [...currentTeamMembers, currentBooZero]
        : currentTeamMembers
      const seenAgentIds = new Set<string>()
      const currentAgents: typeof combinedAgents = []
      for (const a of combinedAgents) {
        if (seenAgentIds.has(a.id)) continue
        seenAgentIds.add(a.id)
        currentAgents.push(a)
      }
      if (!currentTeamId || !currentClient || currentAgents.length === 0) return

      const transcripts = useChatStore.getState().transcripts

      // ── Post-stop freeze ────────────────────────────────────────────────
      // If we're inside the freeze window (the user recently pressed Stop),
      // suppress delegation/relay scanning but still update `lastCountsRef`
      // so that entries that landed during the freeze are treated as
      // already-processed once the freeze lifts. Without this, the
      // post-freeze pass would scan everything that arrived during the
      // freeze and could fire a fresh cascade of delegations.
      if (Date.now() < frozenUntilRef.current) {
        for (const agent of currentAgents) {
          const teamSk = buildTeamSessionKey(agent.id, currentTeamId)
          lastCountsRef.current.set(teamSk, transcripts.get(teamSk)?.length ?? 0)
        }
        return
      }

      // Relay hub: Boo Zero (when available) — every teammate's response is
      // relayed to Boo Zero so the universal leader stays in the loop. Fall
      // back to the team-internal lead when Boo Zero is unavailable.
      const relayHubId = currentBooZero?.id ?? currentInternalLead

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

                  // Wake sleeping agent before relaying (best-effort).
                  //
                  // CRITICAL: this used to call `buildTeamWakeMessage` which
                  // asked the agent to introduce itself AND listed teammates
                  // as `@AgentName`. In production that triggered the
                  // 11-message "Welcome aboard X" cascade (CLAUDE.md §"Group
                  // Chat Onboarding Gate — Cascade Fix"). The Phase 4
                  // onboarding-gate fix already replaced the user-message-
                  // time wake with a silent-resume body — this is the same
                  // fix for the orchestration wake-on-relay path.
                  //
                  // Pair with `### Resuming sessions` in `buildTeamAgentsMd`
                  // which loads on every turn and tells the agent to stay
                  // quiet on resume.
                  //
                  // Per-batch dedup (`wokenThisBatchRef`) below ensures we
                  // don't fire multiple wakes for the same agent inside a
                  // single processing tick — relays often target the same
                  // hub repeatedly.
                  if (
                    !isAgentAwake(targetId, currentTeamId) &&
                    !wokenThisBatchRef.current.has(targetId)
                  ) {
                    wokenThisBatchRef.current.add(targetId)
                    const wakeMsg = buildSilentResumeWakeMessage({
                      agentName: targetAgent.name,
                      teamName: teamNameRef.current,
                    })
                    setTeamChatOverride(targetId, targetTeamSk)
                    await currentClient.call('chat.send', {
                      sessionKey: targetTeamSk,
                      message: wakeMsg,
                      deliver: false,
                      idempotencyKey: crypto.randomUUID(),
                    })
                    // Settle delay reduced from 5000ms → 2000ms. With N
                    // sleeping teammates the original delay multiplied to a
                    // visibly-bunched cascade window; 2s is still enough
                    // for the Gateway to register the session before the
                    // relay arrives, while keeping the overall flow tight.
                    await new Promise((r) => setTimeout(r, 2000))
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

  // ── Stop-signal handler ──────────────────────────────────────────────────
  // When the parent bumps `stopSignal` (Stop button pressed):
  //   1. Cancel any pending debounced batch — don't process whatever is
  //      currently in the chat store with the pre-stop scan logic.
  //   2. Snapshot `lastCountsRef` to current transcript lengths (DO NOT
  //      clear it). Clearing made `processNewEntries` treat every existing
  //      entry as "new" on the next chat-store update, causing it to re-
  //      scan historic `<delegate>` blocks and trigger fresh wake+
  //      delegation cascades. The bug fix is to keep "what we've already
  //      processed" honest across the stop.
  //   3. Clear delegation source map + per-batch dedup. These are
  //      tactical state that shouldn't survive a stop.
  //   4. Open a freeze window (`STOP_FREEZE_MS` from now) during which
  //      `processNewEntries` skips scanning but keeps `lastCountsRef`
  //      current. This catches partial commits from aborted runs, fire-
  //      and-forget IIFEs from the pre-stop batch, and Gateway tail
  //      events. After the freeze, normal processing resumes.
  // The initial `stopSignal=0` is skipped so we don't trigger on mount.
  const prevStopSignalRef = useRef(stopSignal)
  useEffect(() => {
    if (stopSignal === prevStopSignalRef.current) return
    prevStopSignalRef.current = stopSignal

    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    // Snapshot current transcript lengths into lastCountsRef. Reconstruct
    // the dedup'd participant list the same way `processNewEntries` does
    // so the snapshot covers exactly the sessions the hook watches.
    const currentTeamId = teamIdRef.current
    if (currentTeamId) {
      const transcripts = useChatStore.getState().transcripts
      const combined = booZeroAgentRef.current
        ? [...teamAgentsRef.current, booZeroAgentRef.current]
        : teamAgentsRef.current
      const seen = new Set<string>()
      const newCounts = new Map<string, number>()
      for (const agent of combined) {
        if (seen.has(agent.id)) continue
        seen.add(agent.id)
        const teamSk = buildTeamSessionKey(agent.id, currentTeamId)
        newCounts.set(teamSk, transcripts.get(teamSk)?.length ?? 0)
      }
      lastCountsRef.current = newCounts
    }

    delegationSourceRef.current = new Map()
    wokenThisBatchRef.current = new Set()
    frozenUntilRef.current = Date.now() + STOP_FREEZE_MS
  }, [stopSignal])
}
