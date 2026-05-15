import { create } from 'zustand'
import type { TranscriptEntry } from '@clawboo/protocol'

// ─── Clawboo dispatch event ──────────────────────────────────────────────────
//
// Round 7: when Clawboo itself fires `chat.send` to a team specialist —
// either via `dispatchDelegation` (a parsed `<delegate>` tag) or via
// `flushRelayBatch` (forwarding the leader's response as a `[Team Update]`
// envelope) — we record the routing event here. The renderer
// (`buildDelegationLinkages`) consumes the map as a third synthesis source
// alongside `<delegate>` tags and `sessions_send` tool entries, so
// `DelegationCard`s reflect actual Clawboo routing regardless of what the
// LLM emits in its prose.
//
// Wake events (`wakeTeamAgents` in `groupChatSendOperation.ts`) are
// intentionally NOT recorded — those carry the `[RESUME_SIGNAL]` body and
// the target's expected reply is `__resumed__` (filtered). Recording them
// would render 5 empty cards per user message.

export interface ClawbooDispatch {
  /** Stable id for React keys + linkage dedup. */
  dispatchId: string
  /** entryId of the leader's transcript entry that triggered the dispatch. */
  sourceEntryId: string
  /** Agent id of the leader (the source). */
  sourceAgentId: string
  /** Agent id of the team specialist that received the chat.send. */
  targetAgentId: string
  /** Resolved roster name of the target. */
  targetAgentName: string
  /** The message body Clawboo sent (the task or relay summary). */
  taskBody: string
  /** Origin of the dispatch — affects visual badge in DelegationCard. */
  origin: 'dispatch-delegation' | 'relay-batch'
  /** Monotonic sequence key (lib/sequenceKey.ts) so target-response accrual works. */
  sequenceKey: number
  /** Timestamp when Clawboo fired the send. */
  timestampMs: number
  /** Team id — used by `clearClawbooDispatches(teamId)` on Stop / team switch. */
  teamId: string
}

// ─── Round 8B: pending plan state ─────────────────────────────────────────
//
// When the leader emits a `<plan>` block (one or more `<step to="@X">…`
// children), Clawboo captures the steps and progresses through them
// automatically — firing step N+1 each time step N's specialist responds.
// State machine lives here so:
//   • The state survives across the `useTeamOrchestration` debounce window
//     (refs would reset on the hook re-mount that happens on team switch).
//   • The renderer can subscribe and show a step-tracker card per plan.
//   • Stop / team-switch clears everything (`clearPendingPlans(teamId)`).
//
// One pending plan per leader-source-entry: keyed by `${teamId}:${sourceEntryId}`.
// `currentStepIndex` advances 0 → 1 → … → steps.length. When it equals
// `steps.length`, the plan is "complete" and the leader gets a final
// `[Plan Complete]` envelope (assembled from each step's output) so it can
// do final synthesis.

export interface PendingPlanStep {
  /** The agent name as written in `to="…"`. */
  targetName: string
  /** Resolved roster id (or null if the name didn't match any participant). */
  targetAgentId: string | null
  /** Task body emitted by the leader. */
  task: string
  /** Output text from the specialist when the step completes. Null until then. */
  output: string | null
  /** entryId of the specialist's response that satisfied this step (claim anchor). */
  resolvedEntryId: string | null
}

export interface PendingPlan {
  /** Stable id for React keys + dispatch records. */
  planId: string
  /** entryId of the leader entry that emitted the `<plan>` block. */
  sourceEntryId: string
  /** Agent id of the leader (the source). */
  sourceAgentId: string
  /** Team id — used for cleanup + dispatch keys. */
  teamId: string
  /** Steps in source order. Mutated as the plan progresses. */
  steps: PendingPlanStep[]
  /**
   * Index of the step currently in flight (0-based). When `>= steps.length`,
   * the plan is complete and the `[Plan Complete]` envelope has been sent
   * to the leader.
   */
  currentStepIndex: number
  /** Timestamp when the plan was captured (used as the dispatch anchor). */
  timestampMs: number
}

// ─── Store ────────────────────────────────────────────────────────────────────
// Keyed by sessionKey so multiple agent conversations are held simultaneously.

interface ChatStore {
  /** Committed transcript entries, keyed by sessionKey. */
  transcripts: Map<string, TranscriptEntry[]>
  /** Live streaming text that hasn't been committed yet, keyed by sessionKey. */
  streamingText: Map<string, string>
  /**
   * Stream-start timestamp per session (ms since epoch). Captured on the
   * FIRST streaming chunk for a session and used by:
   *   1. `useGatewayEvents.appendOutputLines` to anchor the eventual
   *      committed entry's `timestampMs` (so a long-streaming leader sorts
   *      ABOVE fast specialists that wake mid-stream and commit first).
   *   2. The renderer (`GroupChatPanel`, `chatComponents.MessageList`) to
   *      position the live `StreamingCard` at its chronological slot in the
   *      merged timeline — instead of always-at-the-end, which produced the
   *      visible "leader's card jumps from bottom to top" re-arrangement
   *      on commit (Round 5 production bug).
   * Moved from `lib/streamStartTracker.ts` module-level Map (which wasn't
   * reactive to React) so the renderer subscribes via Zustand.
   */
  streamStartedAt: Map<string, number>
  /**
   * Round 7: Clawboo's outgoing routing events, keyed by
   * `${teamId}:${sourceEntryId}` so each leader entry can accumulate
   * multiple dispatches (e.g., one Boo Zero turn triggering 5 relays).
   * Populated by `useTeamOrchestration` whenever Clawboo fires `chat.send`
   * to a team specialist. Consumed by `buildDelegationLinkages` as the
   * Path 3 source for `DelegationCard` rendering.
   */
  clawbooDispatches: Map<string, ClawbooDispatch[]>
  /**
   * Round 8B: in-progress `<plan>` state machines, keyed by `planId` (one
   * plan per leader-source-entry). Each plan progresses one step at a time
   * — when step N's specialist responds, Clawboo fires step N+1 with the
   * prior output piped in. When all steps complete, the leader receives a
   * `[Plan Complete]` envelope cueing final synthesis. See
   * `useTeamOrchestration` for the state-machine wiring.
   */
  pendingPlans: Map<string, PendingPlan>
  /** Token usage from final chat events, keyed by runId. */
  lastTokenUsage: Map<string, { inputTokens: number; outputTokens: number }>

  /** Append one or more entries to a session's transcript. */
  appendTranscript: (sessionKey: string, entries: TranscriptEntry[]) => void

  /** Set (or clear) the live streaming text for a session. */
  setStreamingText: (sessionKey: string, text: string | null) => void

  /**
   * Capture the first streaming chunk's timestamp. No-op if a stream-start
   * is already recorded for this session (preserves the original anchor
   * across mid-stream patches).
   */
  setStreamStart: (sessionKey: string, ts: number) => void

  /**
   * Clear the stream-start anchor — called at commit time AFTER
   * `appendOutputLines` has read the value so the next streamed turn for
   * the same session re-anchors from scratch.
   */
  clearStreamStart: (sessionKey: string) => void

  /** Wipe all transcript + streaming state for a session. */
  clearTranscript: (sessionKey: string) => void

  /**
   * Record one Clawboo outgoing routing event under the appropriate
   * `${teamId}:${sourceEntryId}` key. Multiple dispatches accumulate per
   * key (one source entry can route to many targets).
   */
  setClawbooDispatch: (dispatch: ClawbooDispatch) => void

  /**
   * Clear ALL dispatches for a given team. Fired on Stop and on team
   * switch so zombie cards from cancelled work don't persist.
   */
  clearClawbooDispatches: (teamId: string) => void

  /**
   * Round 8B: register a new pending plan when the leader emits a
   * `<plan>` block. `useTeamOrchestration` calls this immediately after
   * parsing, then fires step 1.
   */
  setPendingPlan: (plan: PendingPlan) => void

  /**
   * Round 8B: mark a step as resolved with the specialist's output. The
   * orchestration hook calls this when it observes the specialist's reply
   * for the in-flight step. The store also bumps `currentStepIndex` so the
   * hook's next subscription tick fires step N+1.
   */
  resolvePlanStep: (
    planId: string,
    stepIndex: number,
    output: string,
    resolvedEntryId: string,
  ) => void

  /**
   * Round 8B: clear all plans for a team. Fired on Stop and on team-switch
   * (mirrors `clearClawbooDispatches`).
   */
  clearPendingPlans: (teamId: string) => void

  /** Store token usage for a completed run. */
  setLastTokenUsage: (runId: string, inputTokens: number, outputTokens: number) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  transcripts: new Map(),
  streamingText: new Map(),
  streamStartedAt: new Map(),
  clawbooDispatches: new Map(),
  pendingPlans: new Map(),
  lastTokenUsage: new Map(),

  appendTranscript: (sessionKey, entries) =>
    set((state) => {
      const next = new Map(state.transcripts)
      const existing = next.get(sessionKey) ?? []

      // Dedup layer 1: entryId (preserves React key stability across re-fetches).
      const seenIds = new Set(existing.map((e) => e.entryId))

      // Dedup layer 2: content signature (defensive against the production
      // triple-render bug). When the upstream pipeline fires `appendOutputLines`
      // multiple times for the same Gateway frame, each call mints a fresh
      // entryId via `crypto.randomUUID()` — entryId dedup misses, and the
      // store ends up with N copies of the same message.
      //
      // Upstream root cause (Round 2, Phase A): the `commitChat` case in
      // `packages/events/src/handler.ts` does NOT guard against stale
      // terminal events for already-closed runs (the `closedRuns` guard
      // exists only for `updateAgentStatus`). When the Gateway emits
      // multiple `chat:final` frames for the same runId — which can happen
      // legitimately during exec-approval flows AND happens spuriously in
      // some Gateway configurations — every frame produces a fresh
      // `commitChat` intent that calls `appendOutputLines` with new
      // entryIds. We cannot add a runId-only guard at the handler layer
      // because legitimate post-approval continuations have the SAME runId
      // with DIFFERENT text and we want those through.
      //
      // The content signature collapses entries that are clearly the same
      // logical event:
      //
      //   key = `${kind}|${role}|${timestampMs/1000|0}|${text.slice(0,160)}`
      //
      // Scoping is implicit in `sessionKey` (we only check against entries on
      // the same session). The 1-second timestamp bucket allows real
      // re-utterances of the same text later in the conversation through,
      // but blocks the same-frame triplication that production exhibits.
      // First 160 chars of text is plenty to disambiguate distinct messages
      // while keeping the signature cheap.
      function contentSig(e: {
        kind?: string
        role?: string
        timestampMs?: number | null
        text?: string
      }): string {
        const k = e.kind ?? ''
        const r = e.role ?? ''
        const tsBucket = Math.floor((e.timestampMs ?? 0) / 1000)
        const t = (e.text ?? '').slice(0, 160)
        return `${k}|${r}|${tsBucket}|${t}`
      }
      const seenSigs = new Set(existing.map(contentSig))

      const fresh: typeof entries = []
      const droppedByContent: { entryId: string; sig: string }[] = []
      for (const e of entries) {
        if (seenIds.has(e.entryId)) continue
        const sig = contentSig(e)
        if (seenSigs.has(sig)) {
          droppedByContent.push({ entryId: e.entryId, sig })
          continue
        }
        seenIds.add(e.entryId)
        seenSigs.add(sig)
        fresh.push(e)
      }

      // Optional diagnostic (Phase A4) — enable in browser DevTools with
      //   localStorage.setItem('clawboo:debug-triple-render', 'true')
      // to capture the actual upstream source of duplicates the next time
      // production hits this path. Off by default.
      if (
        typeof window !== 'undefined' &&
        droppedByContent.length > 0 &&
        window.localStorage?.getItem('clawboo:debug-triple-render') === 'true'
      ) {
        console.warn('[clawboo:triple-render] dropped content-equivalent entries', {
          sessionKey,
          dropped: droppedByContent,
          stack: new Error().stack?.split('\n').slice(1, 6).join('\n'),
        })
      }

      if (fresh.length === 0) return state
      const merged = [...existing, ...fresh]
      next.set(sessionKey, merged.length > 500 ? merged.slice(-500) : merged)
      return { transcripts: next }
    }),

  setStreamingText: (sessionKey, text) =>
    set((state) => {
      const next = new Map(state.streamingText)
      if (text === null) {
        next.delete(sessionKey)
      } else {
        next.set(sessionKey, text)
      }
      return { streamingText: next }
    }),

  setStreamStart: (sessionKey, ts) =>
    set((state) => {
      // First-capture-wins: if a stream-start is already recorded, don't
      // overwrite. Mid-stream patches keep arriving but the original anchor
      // is what positions the card.
      if (state.streamStartedAt.has(sessionKey)) return state
      const next = new Map(state.streamStartedAt)
      next.set(sessionKey, ts)
      return { streamStartedAt: next }
    }),

  clearStreamStart: (sessionKey) =>
    set((state) => {
      if (!state.streamStartedAt.has(sessionKey)) return state
      const next = new Map(state.streamStartedAt)
      next.delete(sessionKey)
      return { streamStartedAt: next }
    }),

  clearTranscript: (sessionKey) =>
    set((state) => {
      const nextTranscripts = new Map(state.transcripts)
      const nextStreaming = new Map(state.streamingText)
      const nextStreamStart = new Map(state.streamStartedAt)
      nextTranscripts.delete(sessionKey)
      nextStreaming.delete(sessionKey)
      nextStreamStart.delete(sessionKey)
      return {
        transcripts: nextTranscripts,
        streamingText: nextStreaming,
        streamStartedAt: nextStreamStart,
      }
    }),

  setClawbooDispatch: (dispatch) =>
    set((state) => {
      const next = new Map(state.clawbooDispatches)
      const key = `${dispatch.teamId}:${dispatch.sourceEntryId}`
      const existing = next.get(key) ?? []
      // Dedup by dispatchId so a retry from the same call site doesn't
      // accumulate duplicate cards (e.g., dispatchDelegation's 2-second
      // retry-once-on-override-conflict path that reruns the same closure).
      if (existing.some((d) => d.dispatchId === dispatch.dispatchId)) return state
      next.set(key, [...existing, dispatch])
      return { clawbooDispatches: next }
    }),

  clearClawbooDispatches: (teamId) =>
    set((state) => {
      const next = new Map(state.clawbooDispatches)
      let changed = false
      for (const key of next.keys()) {
        if (key.startsWith(`${teamId}:`)) {
          next.delete(key)
          changed = true
        }
      }
      if (!changed) return state
      return { clawbooDispatches: next }
    }),

  setPendingPlan: (plan) =>
    set((state) => {
      // Idempotent — if a plan with the same id is already registered (e.g.,
      // the orchestration hook re-parsed the same leader entry after a
      // page reload), keep the existing one to preserve `output` /
      // `resolvedEntryId` / `currentStepIndex` progress.
      if (state.pendingPlans.has(plan.planId)) return state
      const next = new Map(state.pendingPlans)
      next.set(plan.planId, plan)
      return { pendingPlans: next }
    }),

  resolvePlanStep: (planId, stepIndex, output, resolvedEntryId) =>
    set((state) => {
      const existing = state.pendingPlans.get(planId)
      if (!existing) return state
      const step = existing.steps[stepIndex]
      if (!step) return state
      // Idempotent — already resolved (same output) → no state change.
      if (step.resolvedEntryId === resolvedEntryId && step.output === output) return state
      const nextSteps = existing.steps.map((s, i) =>
        i === stepIndex ? { ...s, output, resolvedEntryId } : s,
      )
      const nextPlan: PendingPlan = {
        ...existing,
        steps: nextSteps,
        // Advance to the next step only if THIS one is the in-flight head.
        // Out-of-order resolves (a later step's response arrives first) are
        // possible in theory but rare; we let the hook re-fire the head step
        // until it lands.
        currentStepIndex:
          stepIndex === existing.currentStepIndex
            ? existing.currentStepIndex + 1
            : existing.currentStepIndex,
      }
      const next = new Map(state.pendingPlans)
      next.set(planId, nextPlan)
      return { pendingPlans: next }
    }),

  clearPendingPlans: (teamId) =>
    set((state) => {
      const next = new Map(state.pendingPlans)
      let changed = false
      for (const [planId, plan] of next) {
        if (plan.teamId === teamId) {
          next.delete(planId)
          changed = true
        }
      }
      if (!changed) return state
      return { pendingPlans: next }
    }),

  setLastTokenUsage: (runId, inputTokens, outputTokens) =>
    set((state) => {
      const next = new Map(state.lastTokenUsage)
      next.set(runId, { inputTokens, outputTokens })
      return { lastTokenUsage: next }
    }),
}))
