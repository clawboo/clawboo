// Team orchestration hook — watches team transcripts for delegation
// patterns and relay triggers. Runs as a background watcher with
// no useState (ref-only) to avoid unnecessary re-renders.

import { useEffect, useRef } from 'react'
import type { GatewayClientLike } from '@clawboo/gateway-client'
import type { AgentState } from '@/stores/fleet'
import { useChatStore, type PendingPlan } from '@/stores/chat'
import { buildTeamSessionKey, setTeamChatOverride, hasTeamChatOverride } from '@/lib/sessionUtils'
import {
  buildBatchedRelayMessage,
  buildTeamContextPreamble,
  buildSilentResumeWakeMessage,
  shouldDropAssistantTurn,
} from '@/lib/teamProtocol'
import { buildBooZeroRulesBlock } from '@/lib/booZeroRules'
import { buildTeamRulesBlock, fetchTeamRules } from '@/lib/teamRules'
import { nextSeq } from '@/lib/sequenceKey'
import { isAgentAwake } from '@/lib/wakeTracker'
import {
  detectDelegations,
  isRelayMessage,
  parseStructuredDelegations,
  type DelegationIntent,
} from './delegationDetector'
import { findPlanBlocks, type PlanStep } from './planDetector'
import {
  condenseSummary,
  determineRelayTargets,
  shouldRelay,
  recordRelay,
  getOrCreateTeamRelayState,
  getRelayDepth,
  incrementRelayDepth,
  DEFAULT_RELAY_CONFIG,
} from './contextRelay'
import { getMergedTeamEntries } from './groupChatSendOperation'

// ─── Stop-generation counter (module-level, keyed by teamId) ────────────────
//
// Bumped on every Stop. Fire-and-forget IIFEs created inside
// `processNewEntries` capture this value at creation and re-check it before
// each side-effecting `await chat.send(...)` — if it has changed, they bail.
// This is what cancels mid-flight wake → settle → relay sequences when the
// user presses Stop during the WAKEUP_SETTLE_MS sleep window (any payload
// that fires AFTER the freeze ends would otherwise re-trigger a cascade).
//
// Module-level (not a React ref) so `stopAllInTeam` in `stopChatOperation.ts`
// can bump it imperatively BEFORE any `await` — eliminating the
// setStopSignal → render → useEffect-commit race that would otherwise leave
// a small window where IIFEs see the old generation. The stop-signal
// useEffect inside the hook also bumps it as belt-and-suspenders.
//
// Same pattern as `wakeInFlight` (in `groupChatSendOperation.ts`) and
// `relayState` (in `contextRelay.ts`) — both intentionally module-level for
// the same reason.

const stopGenerations = new Map<string, number>()

export function getStopGeneration(teamId: string): number {
  return stopGenerations.get(teamId) ?? 0
}

export function bumpStopGeneration(teamId: string): void {
  stopGenerations.set(teamId, (stopGenerations.get(teamId) ?? 0) + 1)
}

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

/**
 * Batching window for context relays destined for the same hub. Production
 * observed Boo Zero acknowledging every parallel `[Team Update]` as a fresh
 * user message — 5 specialists finishing in parallel produced 5 separate
 * "Got it — that's the X layer" acknowledgments from Boo Zero (~576 redundant
 * tokens in one cascade).
 *
 * With batching, items destined for `(teamId, targetId)` accumulate over a
 * 3 s window. When the timer fires, ONE combined `[Team Update]` envelope is
 * delivered containing all teammate progress reports — and the Boo Zero rules
 * block now explicitly forbids acknowledgment-only responses, so the hub
 * produces ONE synthesis (or zero if not warranted).
 *
 * 3 s chosen because: (a) parallel completions from delegations issued in
 * the same Boo Zero response typically land within 500-1500 ms of each
 * other; (b) tighter windows would split natural batches; (c) wider would
 * make a single-item batch feel laggy. Pair with `POST_BATCH_COOLDOWN_MS`
 * below — incoming items during the cooldown extend the NEXT batch instead
 * of triggering an immediate second dispatch.
 */
const RELAY_BATCH_WINDOW_MS = 3000

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

/**
 * One accumulating batch of relay items destined for a single hub. Lives
 * in `pendingRelaysRef` keyed by `${teamId}:${targetId}` until either
 * `RELAY_BATCH_WINDOW_MS` expires (timer fires, batch is flushed as a
 * single `chat.send`) OR the user presses Stop (timer cancelled, batch
 * discarded).
 */
interface PendingRelayBatch {
  targetId: string
  /** Cached target name so `flushRelayBatch` can record dispatches without re-resolving. */
  targetAgentName: string
  items: Array<{
    /** Agent id of the source agent whose commit triggered this relay item. */
    sourceAgentId: string
    /** entryId of the source's committed entry — anchors Round 7 Path 3 cards. */
    sourceEntryId: string
    fromAgentName: string
    body: string
    taskContext?: string
  }>
  /** Stop-generation captured when this batch was opened. */
  startGen: number
  timerId: ReturnType<typeof setTimeout>
  /**
   * Round 8 override-fix: number of times this batch has been deferred
   * because the target had an active chat override (i.e., was processing
   * another message). Each deferral reschedules the flush 2 s later, so
   * the relay doesn't clobber the target's in-flight run with
   * `setTeamChatOverride`. Capped at `RELAY_RETRY_LIMIT` — beyond that,
   * we proceed with the override-overwrite to avoid pathological delay.
   */
  busyRetryCount: number
}

/**
 * Round 8: max retries before we give up waiting for a busy target and
 * dispatch anyway. With `RELAY_RETRY_DELAY_MS = 2000` this yields ~6 s of
 * patience before forcing through — enough for a typical leader turn to
 * finish, not so long that the chat feels stalled.
 */
const RELAY_RETRY_LIMIT = 3
const RELAY_RETRY_DELAY_MS = 2000

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
  /**
   * Mid-stream delegation dedup. Maps sessionKey → Set of `mentionOffset`
   * values for `<delegate>` blocks we've already dispatched (either from
   * the streaming-text path OR from the commit-time path, whichever fired
   * first). Prevents double-routing when a `<delegate>` block closes
   * mid-stream and the same block then appears in the committed entry.
   *
   * Lifecycle:
   *   • Mid-stream scan adds (sessionKey, offset) when it dispatches.
   *   • Commit-time scan also adds (and skips if already present).
   *   • After commit-time processing finishes for a session, the entry
   *     for that sessionKey is cleared — the next streaming burst starts
   *     from offset 0 anyway, so the set would otherwise grow unbounded.
   *   • Mid-stream scan also clears when it observes streamingText
   *     transitioning to null/empty (e.g., setStreamingText(sk, null) at
   *     commitChat time).
   */
  const dispatchedStreamingOffsetsRef = useRef<Map<string, Set<number>>>(new Map())
  /**
   * Round 8B: per-plan-step "already fired" guard. Keyed by
   * `${planId}:${stepIndex}` so the same step never fires twice if
   * `processNewEntries` runs again before the specialist replies. Cleared
   * on Stop / team-switch alongside the other refs.
   */
  const firedPlanStepsRef = useRef<Set<string>>(new Set())
  /**
   * Round 8B: timestamp anchor for the in-flight step of each plan.
   * `findTargetResponse` uses this to claim only specialist replies that
   * arrived AFTER the step was fired (filters out stale entries hydrated
   * from prior sessions). Keyed by `planId`.
   */
  const planStepFiredAtRef = useRef<Map<string, number>>(new Map())
  /**
   * Round 8B: dedup guard for the `[Plan Complete]` envelope. Once we've
   * fired the final synthesis cue for a plan, don't fire it again on every
   * subsequent subscription tick.
   */
  const planCompletedSetRef = useRef<Set<string>>(new Set())
  /**
   * Pending relay batches keyed by `${teamId}:${targetId}`. Each batch
   * accumulates items over `RELAY_BATCH_WINDOW_MS` and is then flushed as a
   * single combined `[Team Update]` envelope to the target. See the constant's
   * doc comment and Layer 2 in the plan for full rationale.
   */
  const pendingRelaysRef = useRef<Map<string, PendingRelayBatch>>(new Map())
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

    // ── Round 7: Clawboo-dispatch recorder ─────────────────────────────────
    // Every `chat.send` Clawboo fires to a team specialist passes through
    // one of two chokepoints (`dispatchDelegation` for delegations,
    // `flushRelayBatch` for relays). Each one calls this helper AFTER the
    // network round-trip succeeds so the renderer can surface the routing
    // event as a DelegationCard — see `buildDelegationLinkages` Path 3.
    //
    // `sourceEntryId` is undefined for mid-stream dispatches (the source
    // entry hasn't committed yet) — we skip recording in that case because
    // Path 1 (`<delegate>` scan in `findDelegationBlocks`) will render the
    // card via the leader's committed text. Recording only happens when a
    // committed entryId is available, which is exactly when Path 1 / Path 2
    // can't claim the routing (fallback regex from `detectDelegations` and
    // relay-batch).
    const recordClawbooDispatch = (params: {
      sourceEntryId: string | undefined
      sourceAgentId: string
      targetAgentId: string
      targetAgentName: string
      taskBody: string
      origin: 'dispatch-delegation' | 'relay-batch'
    }): void => {
      if (!params.sourceEntryId) return
      const currentTeamId = teamIdRef.current
      if (!currentTeamId) return
      useChatStore.getState().setClawbooDispatch({
        dispatchId: crypto.randomUUID(),
        sourceEntryId: params.sourceEntryId,
        sourceAgentId: params.sourceAgentId,
        targetAgentId: params.targetAgentId,
        targetAgentName: params.targetAgentName,
        taskBody: params.taskBody,
        origin: params.origin,
        sequenceKey: nextSeq(),
        timestampMs: Date.now(),
        teamId: currentTeamId,
      })
    }

    // ── Shared delegation dispatcher ───────────────────────────────────────
    // Used by both the mid-stream `<delegate>` scanner (which fires as soon
    // as a `</delegate>` closing tag appears in the streaming text) AND the
    // commit-time scanner inside `processNewEntries`. The dispatch path is
    // identical: identity rules + team rules + team context preamble + task
    // body → `chat.send` to the target's team-scoped session. Extracting
    // this once keeps the two scan paths in lock-step.
    //
    // `sourceEntryId` is passed only from the commit-time path (mid-stream
    // hasn't committed yet); see `recordClawbooDispatch` above for the
    // skip-when-undefined logic.
    const dispatchDelegation = (
      delegation: DelegationIntent,
      sourceAgentId: string,
      sourceEntryId: string | undefined,
      retryCount = 0,
    ): void => {
      const currentTeamId = teamIdRef.current
      const currentClient = clientRef.current
      if (!currentTeamId || !currentClient) return

      // Capture the stop-generation at IIFE creation. If the user presses
      // Stop before this IIFE finishes, the generation bumps; we bail at
      // each checkpoint below instead of issuing a stale `chat.send` that
      // would restart the cascade.
      const startGen = getStopGeneration(currentTeamId)
      void (async () => {
        try {
          if (getStopGeneration(currentTeamId) !== startGen) return

          // Guard: target agent may have been deleted during processing.
          // Boo Zero may be the target — check both team members AND Boo
          // Zero (Boo Zero is teamless so not in `teamAgentsRef`).
          const freshTeamMembers = teamAgentsRef.current
          const freshBooZero = booZeroAgentRef.current
          const freshParticipants = freshBooZero
            ? [...freshTeamMembers, freshBooZero]
            : freshTeamMembers
          if (!freshParticipants.some((a) => a.id === delegation.targetAgentId)) return

          // Guard: target is already processing a team message — retry once after 2s
          if (hasTeamChatOverride(delegation.targetAgentId)) {
            if (retryCount < 1) {
              // The retry inherits the same startGen via closure on the next
              // call — when it fires it re-checks against the live generation.
              setTimeout(
                () => dispatchDelegation(delegation, sourceAgentId, sourceEntryId, retryCount + 1),
                2000,
              )
            }
            return
          }

          const targetTeamSk = buildTeamSessionKey(delegation.targetAgentId, currentTeamId)

          // Set override BEFORE sending so Gateway events get redirected.
          setTeamChatOverride(delegation.targetAgentId, targetTeamSk)

          // Build context preamble from merged transcript — also injects the
          // user intro so the target agent knows who the user is (delegations
          // are agent-to-agent, no fresh user message).
          const contextEntries = getMergedTeamEntries(currentTeamId, freshTeamMembers, freshBooZero)
          const targetAgent = freshParticipants.find((a) => a.id === delegation.targetAgentId)
          const preamble = buildTeamContextPreamble({
            entries: contextEntries,
            targetAgentName: targetAgent?.name ?? '',
            userIntroText: userIntroTextRef.current,
          })

          // Agent → Boo Zero delegations need the rules block — Boo Zero
          // stays identity-anchored and rule-bound across every delivery
          // path (user turns, wake-ups, AND agent-to-Boo-Zero delegations).
          const isDelegationToBooZero =
            freshBooZero !== null && delegation.targetAgentId === freshBooZero.id
          const rulesBlock = isDelegationToBooZero
            ? buildBooZeroRulesBlock({
                displayName: freshBooZero!.name,
                teamName: teamNameRef.current,
              })
            : null

          // Team Rules — same source of truth as user-message-time injection.
          // Loaded for every agent-to-agent delegation so the user's
          // persisted corrections never get lost as work hops between
          // teammates.
          const teamRulesContent = await fetchTeamRules(currentTeamId)
          const teamRulesBlock = buildTeamRulesBlock(teamRulesContent)

          const sections = [
            rulesBlock,
            teamRulesBlock,
            preamble,
            delegation.taskDescription,
          ].filter((s): s is string => Boolean(s))
          const messageBody = sections.join('\n\n')

          // Final checkpoint before the network call.
          if (getStopGeneration(currentTeamId) !== startGen) return

          await currentClient.call('chat.send', {
            sessionKey: targetTeamSk,
            message: messageBody,
            deliver: false,
            idempotencyKey: crypto.randomUUID(),
          })

          // Track delegation source for relay routing.
          delegationSourceRef.current.set(delegation.targetAgentId, sourceAgentId)

          // Round 7: record this dispatch so the renderer can surface it
          // as a DelegationCard. Skipped when `sourceEntryId` is undefined
          // (mid-stream path — Path 1 handles `<delegate>` rendering via
          // `findDelegationBlocks` on the committed text).
          recordClawbooDispatch({
            sourceEntryId,
            sourceAgentId,
            targetAgentId: delegation.targetAgentId,
            targetAgentName: targetAgent?.name ?? delegation.targetAgentId,
            taskBody: delegation.taskDescription,
            origin: 'dispatch-delegation',
          })
        } catch {
          // Non-fatal — delegation failure doesn't block other processing.
        }
      })()
    }

    // ── Round 8B: plan-step dispatcher ─────────────────────────────────────
    // Fires one step of a `<plan>` block as a delegation. Builds a task body
    // that includes the prior steps' outputs as context (so step N+1 sees
    // what step N produced). Guarded by `firedPlanStepsRef` so the same
    // step never dispatches twice. Reuses `dispatchDelegation` for the
    // actual `chat.send` + recording machinery — this is just the message-
    // composition layer.
    const dispatchPlanStep = (plan: PendingPlan, stepIndex: number): void => {
      const step = plan.steps[stepIndex]
      if (!step || !step.targetAgentId) return
      const guardKey = `${plan.planId}:${stepIndex}`
      if (firedPlanStepsRef.current.has(guardKey)) return
      firedPlanStepsRef.current.add(guardKey)
      planStepFiredAtRef.current.set(plan.planId, Date.now())

      // Compose the task body: prior outputs (when any) prepended as
      // context blocks, then the current step's task at the bottom.
      const priorOutputs = plan.steps
        .slice(0, stepIndex)
        .map((s, i) => ({ idx: i, name: s.targetName, output: s.output }))
        .filter((s): s is { idx: number; name: string; output: string } => Boolean(s.output))
      const contextBlocks = priorOutputs
        .map(
          (s) =>
            `[Plan step ${s.idx + 1} — @${s.name}'s output]\n${s.output}\n[End step ${s.idx + 1}]`,
        )
        .join('\n\n')
      const taskBody = contextBlocks
        ? `${contextBlocks}\n\n---\n\nYour step (#${stepIndex + 1} of ${plan.steps.length}) in this plan:\n${step.task}`
        : step.task

      const intent: DelegationIntent = {
        targetAgentId: step.targetAgentId,
        targetAgentName: step.targetName,
        taskDescription: taskBody,
        sourceAgentId: plan.sourceAgentId,
        // Use the step index as the mentionOffset so each step has a stable
        // positional key in case future linkage logic dedups by it.
        mentionOffset: stepIndex,
      }
      dispatchDelegation(intent, plan.sourceAgentId, plan.sourceEntryId)
    }

    // ── Round 8B: send `[Plan Complete]` envelope to the leader ────────────
    // Fired once when the plan's final step resolves. The leader's rules
    // block (Round 8D) tells it to treat `[Plan Complete]` as the cue for
    // final synthesis — bypasses the silence-on-relay rule.
    const sendPlanCompleteEnvelope = (plan: PendingPlan): void => {
      if (planCompletedSetRef.current.has(plan.planId)) return
      planCompletedSetRef.current.add(plan.planId)

      const currentTeamId = teamIdRef.current
      const currentClient = clientRef.current
      if (!currentTeamId || !currentClient) return

      const leaderAgent =
        teamAgentsRef.current.find((a) => a.id === plan.sourceAgentId) ??
        (booZeroAgentRef.current && booZeroAgentRef.current.id === plan.sourceAgentId
          ? booZeroAgentRef.current
          : null)
      if (!leaderAgent) return

      const leaderSk = buildTeamSessionKey(plan.sourceAgentId, currentTeamId)
      const summary = plan.steps
        .map((s, i) => `[Step ${i + 1} — @${s.targetName}]\n${s.output ?? '(no output)'}`)
        .join('\n\n---\n\n')
      const body = `[Plan Complete] — all ${plan.steps.length} step(s) of your plan have finished.\nThe outputs are below. Synthesize a final answer for the user.\n---\n${summary}\n---`

      // Identity rules + team rules (same machinery used by dispatchDelegation
      // for Boo Zero deliveries). The whole point of the envelope is to
      // re-enter the leader on a fresh turn with full context.
      const isBooZero =
        booZeroAgentRef.current !== null && plan.sourceAgentId === booZeroAgentRef.current.id
      const sections: string[] = []
      if (isBooZero) {
        sections.push(
          buildBooZeroRulesBlock({
            displayName: leaderAgent.name,
            teamName: teamNameRef.current,
          }),
        )
      }
      sections.push(body)
      const messageBody = sections.join('\n\n')

      const startGen = getStopGeneration(currentTeamId)
      void (async () => {
        try {
          if (getStopGeneration(currentTeamId) !== startGen) return
          if (
            hasTeamChatOverride(plan.sourceAgentId) &&
            !planCompletedSetRef.current.has(`${plan.planId}:retry`)
          ) {
            // Defer once if leader is busy — Round 8 override-fix
            // philosophy. Re-fire on next subscription tick.
            planCompletedSetRef.current.delete(plan.planId)
            return
          }
          setTeamChatOverride(plan.sourceAgentId, leaderSk)
          await currentClient.call('chat.send', {
            sessionKey: leaderSk,
            message: messageBody,
            deliver: false,
            idempotencyKey: crypto.randomUUID(),
          })
        } catch {
          // Non-fatal.
        }
      })()
    }

    // ── Mid-stream `<delegate>` scanner ────────────────────────────────────
    // Fires on every chat-store change with NO debounce so DelegationCards
    // appear inline as soon as the LLM closes a `</delegate>` tag — instead
    // of after the leader's full response commits (often 20-30 s later).
    // This is the topology fix: by routing targets mid-stream, specialists
    // start working WHILE the leader is still streaming, so the user sees
    // them respond in the natural flow rather than after a long silence.
    //
    // Dedup: every block dispatched here is recorded in
    // `dispatchedStreamingOffsetsRef` so the commit-time scanner doesn't
    // re-dispatch the same block when the entry lands. The set is keyed by
    // `sessionKey + mentionOffset` (the byte offset of the `<delegate>`
    // opener in the source text — stable across the streaming-to-commit
    // transition because we only dispatch CLOSED blocks).
    const processStreamingDelegations = (): void => {
      const currentTeamId = teamIdRef.current
      if (!currentTeamId) return
      if (Date.now() < frozenUntilRef.current) return

      const currentTeamMembers = teamAgentsRef.current
      const currentBooZero = booZeroAgentRef.current
      const combined = currentBooZero ? [...currentTeamMembers, currentBooZero] : currentTeamMembers
      if (combined.length === 0) return

      const seen = new Set<string>()
      const participants: AgentState[] = []
      for (const a of combined) {
        if (seen.has(a.id)) continue
        seen.add(a.id)
        participants.push(a)
      }

      const streamingText = useChatStore.getState().streamingText
      for (const agent of participants) {
        const teamSk = buildTeamSessionKey(agent.id, currentTeamId)
        const streaming = streamingText.get(teamSk)
        if (!streaming || streaming.length === 0) {
          // End-of-stream signal — clear so the next streaming burst starts
          // from offset 0 without false dedup hits.
          dispatchedStreamingOffsetsRef.current.delete(teamSk)
          continue
        }
        if (isRelayMessage(streaming)) continue

        const intents = parseStructuredDelegations(
          streaming,
          agent.id,
          participants.map((p) => ({ id: p.id, name: p.name })),
        )
        if (intents.length === 0) continue

        let dispatched = dispatchedStreamingOffsetsRef.current.get(teamSk)
        if (!dispatched) {
          dispatched = new Set<number>()
          dispatchedStreamingOffsetsRef.current.set(teamSk, dispatched)
        }
        for (const intent of intents) {
          if (dispatched.has(intent.mentionOffset)) continue
          dispatched.add(intent.mentionOffset)
          // Mid-stream: source entry hasn't committed yet — pass undefined
          // so the recorder skips. Path 1 (`<delegate>` scan on committed
          // text) will render the card when the entry lands.
          dispatchDelegation(intent, agent.id, undefined)
        }
      }
    }

    // ── Relay batching ─────────────────────────────────────────────────────
    //
    // Replaces the previous per-target IIFE relay loop. Each item destined
    // for `(teamId, targetId)` is accumulated; the first item starts a 3-s
    // batch window; the timer flushes the combined batch as ONE `chat.send`.
    // Same hub never receives N parallel relays. See `buildBatchedRelayMessage`
    // in `lib/teamProtocol.ts` for the envelope shape.

    const flushRelayBatch = (key: string): void => {
      const batch = pendingRelaysRef.current.get(key)
      if (!batch) return

      const currentTeamId = teamIdRef.current
      const currentClient = clientRef.current
      if (!currentTeamId || !currentClient) {
        pendingRelaysRef.current.delete(key)
        return
      }
      if (getStopGeneration(currentTeamId) !== batch.startGen) {
        pendingRelaysRef.current.delete(key)
        return
      }

      const freshBooZero = booZeroAgentRef.current
      const freshTeamMembers = teamAgentsRef.current
      const targetAgent =
        freshTeamMembers.find((a) => a.id === batch.targetId) ??
        (freshBooZero && freshBooZero.id === batch.targetId ? freshBooZero : null)
      if (!targetAgent) {
        pendingRelaysRef.current.delete(key)
        return
      }

      // Round 8 override-fix: if the target is currently processing another
      // message (`hasTeamChatOverride` returns truthy), our `chat.send` here
      // would overwrite the active override slot via `setTeamChatOverride`
      // below — corrupting routing for the target's in-flight turn and
      // adding 30-60 s of latency before our relay can be processed. Defer
      // the flush by `RELAY_RETRY_DELAY_MS` so the target's current run has
      // a chance to finish. We keep the batch in the pending map and bump
      // `busyRetryCount`. After `RELAY_RETRY_LIMIT` retries we fall through
      // and dispatch anyway — better to ship a possibly-conflicted relay
      // than to silently drop the routing event.
      if (hasTeamChatOverride(batch.targetId) && batch.busyRetryCount < RELAY_RETRY_LIMIT) {
        batch.busyRetryCount += 1
        batch.timerId = setTimeout(() => flushRelayBatch(key), RELAY_RETRY_DELAY_MS)
        return
      }

      // From here on the batch is going out — remove it from the pending
      // map so subsequent `enqueueRelayItem` calls open a fresh batch.
      pendingRelaysRef.current.delete(key)

      const targetTeamSk = buildTeamSessionKey(batch.targetId, currentTeamId)
      setTeamChatOverride(batch.targetId, targetTeamSk)

      const baseRelay = buildBatchedRelayMessage(batch.items)
      const isRelayToBooZero = freshBooZero !== null && batch.targetId === freshBooZero.id
      const finalRelayMsg = isRelayToBooZero
        ? `${buildBooZeroRulesBlock({ displayName: targetAgent.name, teamName: teamNameRef.current })}\n\n${baseRelay}`
        : baseRelay

      void (async () => {
        try {
          if (getStopGeneration(currentTeamId) !== batch.startGen) return
          await currentClient.call('chat.send', {
            sessionKey: targetTeamSk,
            message: finalRelayMsg,
            deliver: false,
            idempotencyKey: crypto.randomUUID(),
          })

          // Round 7: emit one dispatch record per accumulated item so each
          // source-entry → target-agent routing surfaces as a DelegationCard.
          // The batched envelope contains all items, but visually each source
          // turn should be linked to its own card on the target.
          for (const item of batch.items) {
            recordClawbooDispatch({
              sourceEntryId: item.sourceEntryId,
              sourceAgentId: item.sourceAgentId,
              targetAgentId: batch.targetId,
              targetAgentName: batch.targetAgentName,
              taskBody: item.body,
              origin: 'relay-batch',
            })
          }
        } catch {
          // Non-fatal.
        }
      })()
    }

    const enqueueRelayItem = (params: {
      teamId: string
      targetId: string
      /** Source agent id whose committed entry triggered this relay item. */
      sourceAgentId: string
      /** entryId of the source's committed entry — anchors Round 7 Path 3 cards. */
      sourceEntryId: string
      fromAgentName: string
      condensedBody: string
    }): void => {
      const key = `${params.teamId}:${params.targetId}`
      let batch = pendingRelaysRef.current.get(key)

      if (!batch) {
        const startGen = getStopGeneration(params.teamId)
        const freshBooZero = booZeroAgentRef.current
        const freshTeamMembers = teamAgentsRef.current
        const currentClient = clientRef.current
        const targetAgent =
          freshTeamMembers.find((a) => a.id === params.targetId) ??
          (freshBooZero && freshBooZero.id === params.targetId ? freshBooZero : null)
        if (!targetAgent || !currentClient) return

        // Wake the target on FIRST item if sleeping. The wake send + 3-s
        // batch window doubles as the settle delay (Gateway registers the
        // session before the flushed relay lands).
        if (
          !isAgentAwake(params.targetId, params.teamId) &&
          !wokenThisBatchRef.current.has(params.targetId)
        ) {
          wokenThisBatchRef.current.add(params.targetId)
          const targetTeamSk = buildTeamSessionKey(params.targetId, params.teamId)
          const baseWake = buildSilentResumeWakeMessage({
            agentName: targetAgent.name,
            teamName: teamNameRef.current,
          })
          const isBooZeroWake = freshBooZero !== null && params.targetId === freshBooZero.id
          const wakeMsg = isBooZeroWake
            ? `${buildBooZeroRulesBlock({ displayName: targetAgent.name, teamName: teamNameRef.current })}\n\n${baseWake}`
            : baseWake
          setTeamChatOverride(params.targetId, targetTeamSk)
          void (async () => {
            try {
              if (getStopGeneration(params.teamId) !== startGen) return
              await currentClient.call('chat.send', {
                sessionKey: targetTeamSk,
                message: wakeMsg,
                deliver: false,
                idempotencyKey: crypto.randomUUID(),
              })
            } catch {
              // Non-fatal.
            }
          })()
        }

        batch = {
          targetId: params.targetId,
          targetAgentName: targetAgent.name,
          items: [],
          startGen,
          timerId: setTimeout(() => flushRelayBatch(key), RELAY_BATCH_WINDOW_MS),
          busyRetryCount: 0,
        }
        pendingRelaysRef.current.set(key, batch)
      }

      batch.items.push({
        sourceAgentId: params.sourceAgentId,
        sourceEntryId: params.sourceEntryId,
        fromAgentName: params.fromAgentName,
        body: params.condensedBody,
      })
    }

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

          // Dedup against mid-stream dispatches: any `<delegate>` block at
          // the same byte offset already routed by `processStreamingDelegations`
          // is skipped here so the same block doesn't double-fire.
          let dispatched = dispatchedStreamingOffsetsRef.current.get(teamSk)
          if (!dispatched) {
            dispatched = new Set<number>()
            dispatchedStreamingOffsetsRef.current.set(teamSk, dispatched)
          }
          for (const delegation of delegations) {
            if (dispatched.has(delegation.mentionOffset)) continue
            dispatched.add(delegation.mentionOffset)
            // Pass the committed source entryId so `recordClawbooDispatch`
            // (Round 7 Path 3) can attribute the dispatch to this turn.
            dispatchDelegation(delegation, sourceAgentId, entry.entryId)
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

            // Condense the source's body once; the batcher accumulates this
            // per-target, then `buildBatchedRelayMessage` assembles a single
            // multi-source envelope at flush time.
            const condensedBody = condenseSummary(text, DEFAULT_RELAY_CONFIG.maxSummaryChars)

            for (const targetId of targets) {
              enqueueRelayItem({
                teamId: currentTeamId,
                targetId,
                // Pipe the committed source's identity through to the batch
                // so `flushRelayBatch` can record a Round 7 dispatch for the
                // renderer.
                sourceAgentId,
                sourceEntryId: entry.entryId,
                fromAgentName: agent.name,
                condensedBody,
              })
            }

            recordRelay(currentTeamId, sourceAgentId)
            incrementRelayDepth(currentTeamId, sourceAgentId)
            // Clean up delegation source after relay is queued.
            delegationSourceRef.current.delete(sourceAgentId)
          }

          // ── Round 8B: plan capture ─────────────────────────────────────
          // Parse `<plan>` blocks in the committed leader entry. For each
          // plan, register it in the chat store and fire step 1. Steps 2+
          // are fired automatically as each prior step's specialist responds
          // (see the plan-progression pass at the bottom of this function).
          // Inline target-name resolver (case-insensitive longest-prefix
          // match against the dedup'd participant list — same heuristic as
          // `delegationDetector.resolveTargetName`).
          const resolveStepTarget = (raw: string): { id: string; name: string } | null => {
            const stripped = raw.replace(/^@/, '').trim().toLowerCase()
            if (!stripped) return null
            const sorted = [...currentAgents].sort((a, b) => b.name.length - a.name.length)
            for (const a of sorted) {
              if (stripped === a.name.toLowerCase()) return { id: a.id, name: a.name }
            }
            for (const a of sorted) {
              const lower = a.name.toLowerCase()
              if (stripped.startsWith(lower) || lower.startsWith(stripped))
                return { id: a.id, name: a.name }
            }
            return null
          }
          const planBlocks = findPlanBlocks(text)
          for (const planBlock of planBlocks) {
            if (planBlock.steps.length === 0) continue
            const planId = `${currentTeamId}:${entry.entryId}:plan:${planBlock.blockStart}`
            // Resolve each step's target name → agent id once at capture
            // time so progression doesn't have to re-resolve on every tick.
            const resolvedSteps = planBlock.steps.map((step: PlanStep) => {
              const target = resolveStepTarget(step.targetName)
              return {
                targetName: target?.name ?? step.targetName.replace(/^@/, '').trim(),
                targetAgentId: target?.id ?? null,
                task: step.task,
                output: null as string | null,
                resolvedEntryId: null as string | null,
              }
            })
            const plan: PendingPlan = {
              planId,
              sourceEntryId: entry.entryId,
              sourceAgentId,
              teamId: currentTeamId,
              steps: resolvedSteps,
              currentStepIndex: 0,
              timestampMs: entry.timestampMs ?? Date.now(),
            }
            useChatStore.getState().setPendingPlan(plan)
            // Fire step 1 immediately. Subsequent steps fire from the
            // progression pass below as each prior step resolves.
            dispatchPlanStep(plan, 0)
          }
        }
      }

      // ── Round 8B: plan progression pass ──────────────────────────────
      // Iterate all pending plans for this team. For each plan whose
      // active step's target has a fresh substantive response, resolve
      // the step and fire the next step (or send `[Plan Complete]`).
      const allPlans = useChatStore.getState().pendingPlans
      for (const plan of allPlans.values()) {
        if (plan.teamId !== currentTeamId) continue
        // Re-read because resolvePlanStep mutates currentStepIndex.
        const livePlan = useChatStore.getState().pendingPlans.get(plan.planId)
        if (!livePlan) continue
        // Plan complete? Send the synthesis envelope (once).
        if (livePlan.currentStepIndex >= livePlan.steps.length) {
          sendPlanCompleteEnvelope(livePlan)
          continue
        }
        const stepIndex = livePlan.currentStepIndex
        const step = livePlan.steps[stepIndex]
        if (!step || !step.targetAgentId) continue
        // Active step already resolved → advance via store action (no
        // network call needed — we already pushed the resolution).
        if (step.output !== null) {
          // dispatchPlanStep is idempotent via firedPlanStepsRef so we can
          // call it freely after the store advances.
          if (livePlan.currentStepIndex < livePlan.steps.length) {
            dispatchPlanStep(livePlan, livePlan.currentStepIndex)
          }
          continue
        }
        // Look for the specialist's fresh response: any assistant entry
        // from this step's target with timestamp AFTER the step was fired
        // (or after the plan was captured if `stepFiredAt` isn't set).
        const stepFiredAt = planStepFiredAtRef.current.get(livePlan.planId) ?? livePlan.timestampMs
        const targetSk = buildTeamSessionKey(step.targetAgentId, currentTeamId)
        const targetEntries = transcripts.get(targetSk)
        if (!targetEntries) continue
        const reply = targetEntries.find(
          (e) =>
            e.role === 'assistant' &&
            e.kind === 'assistant' &&
            (e.timestampMs ?? 0) > stepFiredAt &&
            e.text.length > 0 &&
            !shouldDropAssistantTurn(e.text),
        )
        if (!reply) continue
        // Resolve the step → advances currentStepIndex by 1 in the store.
        useChatStore
          .getState()
          .resolvePlanStep(livePlan.planId, stepIndex, reply.text, reply.entryId)
        // Fire the next step (if any). The progression pass loops over all
        // plans on every tick, so we don't strictly need to fire here —
        // the next tick would catch it. But firing immediately avoids one
        // tick of latency.
        const nextIndex = stepIndex + 1
        if (nextIndex < livePlan.steps.length) {
          dispatchPlanStep(livePlan, nextIndex)
        } else {
          sendPlanCompleteEnvelope(livePlan)
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

    // Subscribe to chat store changes.
    //
    // Mid-stream delegation detection (`processStreamingDelegations`) fires
    // IMMEDIATELY on every change so DelegationCards appear inline as soon
    // as the LLM closes a `</delegate>` tag — instead of after the leader's
    // full response commits (often 20-30 s later). The scan is cheap (one
    // regex per active team session).
    //
    // Commit-time scanning (`processNewEntries`) stays on a 500 ms debounce
    // because it does heavier work — context preamble builds, team-rules
    // fetches, relay routing decisions. Mid-stream dispatches are recorded
    // in `dispatchedStreamingOffsetsRef` so the committed-entry pass doesn't
    // re-route what already fired.
    const unsub = useChatStore.subscribe(() => {
      processStreamingDelegations()
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
      // Cancel + discard any pending relay batches when the hook unmounts
      // (team switch, page navigation). Without this, a timer scheduled
      // before unmount would fire after the team is gone and try to
      // `chat.send` to a stale team's session.
      for (const batch of pendingRelaysRef.current.values()) {
        clearTimeout(batch.timerId)
      }
      pendingRelaysRef.current = new Map()
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
      // Belt-and-suspenders bump — `stopAllInTeam` also calls
      // `bumpStopGeneration(teamId)` synchronously before any await, but
      // bumping here too means even a caller that skipped `stopAllInTeam`
      // (e.g. some future test harness that drives stopSignal directly)
      // still cancels in-flight IIFEs.
      bumpStopGeneration(currentTeamId)

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
    // Clear mid-stream dispatch dedup — any in-flight streaming burst that
    // continues to commit after Stop should be treated as fresh (its
    // `<delegate>` blocks were already cancelled at the dispatch layer via
    // the stop-generation bump in `dispatchDelegation`, so no double-send
    // risk; we just don't want stale offsets to silently mask future blocks
    // at the same byte position in a different turn).
    dispatchedStreamingOffsetsRef.current = new Map()
    // Cancel any pending relay batches AND discard their accumulated items.
    // Without this, a 3-second timer scheduled before Stop would fire
    // afterwards and dispatch a relay containing pre-stop teammate updates.
    // The downstream `chat.send` would be cancelled by the bumped
    // stop-generation check inside `flushRelayBatch`, but we avoid the
    // network call and the noisy log by clearing here.
    for (const batch of pendingRelaysRef.current.values()) {
      clearTimeout(batch.timerId)
    }
    pendingRelaysRef.current = new Map()
    // Round 7: wipe Clawboo's dispatched-routing records for this team so
    // the renderer's Path 3 cards from cancelled work don't linger.
    if (currentTeamId) {
      useChatStore.getState().clearClawbooDispatches(currentTeamId)
      // Round 8B: also wipe any in-progress `<plan>` state machines so the
      // next step doesn't fire after Stop.
      useChatStore.getState().clearPendingPlans(currentTeamId)
    }
    // Reset Round 8B refs so a new plan after Stop starts fresh.
    firedPlanStepsRef.current = new Set()
    planStepFiredAtRef.current = new Map()
    planCompletedSetRef.current = new Set()
    frozenUntilRef.current = Date.now() + STOP_FREEZE_MS
  }, [stopSignal])
}
