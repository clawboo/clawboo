import type { AgentStatus, EventFrame } from '@clawboo/gateway-client'
import type { Logger } from '@clawboo/logger'

// ── Chat and Agent event payloads ──────────────────────────────────────────

export type ChatState = 'delta' | 'final' | 'aborted' | 'error'

export type ChatEventPayload = {
  runId: string
  sessionKey: string
  state: ChatState
  seq?: number
  stopReason?: string
  message?: unknown // raw message object from gateway
  errorMessage?: string
  model?: string
}

/**
 * Token spend for one committed turn, derived purely from the frame.
 *
 * `inputTokens` is `null` when the Gateway sent no usage block — the prompt
 * size then has to be estimated from the agent's last user message, which is a
 * store read and therefore the host's job, not the Policy layer's.
 */
export type ChatCost = {
  model: string
  inputTokens: number | null
  outputTokens: number
}

export type AgentEventPayload = {
  runId: string
  seq?: number
  stream?: string // 'lifecycle' | 'assistant' | 'tool' | reasoning streams
  data?: Record<string, unknown>
  sessionKey?: string
}

// ── ClassifiedEvent ────────────────────────────────────────────────────────

export type EventKind =
  | 'summary-refresh' // presence / heartbeat
  | 'runtime-chat' // chat delta / final / aborted / error
  | 'runtime-agent' // agent lifecycle + all streams
  | 'approval' // exec.approval.pending / resolved
  | 'unknown'

export interface ClassifiedEvent {
  kind: EventKind
  agentId?: string
  sessionKey?: string
  payload: unknown
  timestamp: number
  raw: EventFrame
}

// ── Agent state patch ──────────────────────────────────────────────────────

export type AgentStatusPatch = {
  status?: AgentStatus
  runId?: string | null
  runStartedAt?: number | null
  streamText?: string | null
  thinkingTrace?: string | null
  lastActivityAt?: number
}

// ── EventPlane ─────────────────────────────────────────────────────────────

export type EventPlane = 'work' | 'agent' | 'trust'

// ── EventIntent — typed discriminated union ────────────────────────────────

export type EventIntent =
  // Work plane — streaming (RAF-batched)
  | {
      kind: 'queueLivePatch'
      plane: 'work'
      agentId: string
      sessionKey?: string
      patch: AgentStatusPatch
    }
  | { kind: 'clearPendingLivePatch'; plane: 'work'; agentId: string }
  // Work plane — terminal (immediate)
  | {
      kind: 'commitChat'
      plane: 'work'
      agentId: string
      sessionKey?: string
      /**
       * The runId of the frame that produced this commit. Distinct from
       * `patch.runId`, which is ALWAYS null here (the patch *closes* the run).
       * The Handler needs the INCOMING id to recognise a replayed terminal
       * frame — by the time one arrives, the agent's current runId has already
       * been cleared, so it can never name the run being recognised.
       */
      runId: string | null
      patch: AgentStatusPatch
      outputLines: string[]
      /**
       * Token spend to bill for this turn, or `null` when there is nothing to
       * bill (an `aborted`/`error` final, or a message with no usable content).
       *
       * Riding on `commitChat` is deliberate: cost accounting used to run off a
       * SECOND raw-frame subscription that re-parsed every `chat:final` itself,
       * so a replayed frame was billed twice — the transcript guard below could
       * not reach it. Here it inherits that guard for free.
       */
      cost: ChatCost | null
    }
  // Agent plane
  | {
      kind: 'updateAgentStatus'
      plane: 'agent'
      agentId: string
      /** Incoming lifecycle frame's runId (`patch.runId` is null on terminal). */
      runId: string | null
      patch: AgentStatusPatch
    }
  | {
      kind: 'scheduleSummaryRefresh'
      plane: 'agent'
      delayMs: number
      includeHeartbeatRefresh: boolean
    }
  | {
      kind: 'requestHistoryRefresh'
      plane: 'agent'
      agentId: string
      reason: 'chat-final-no-trace'
    }
  // Trust plane
  | { kind: 'approvalPending'; plane: 'trust'; agentId: string; payload: unknown }
  | { kind: 'approvalResolved'; plane: 'trust'; agentId: string; payload: unknown }
  // Control
  | { kind: 'ignore'; reason: string }

// ── EventHandlerDeps ───────────────────────────────────────────────────────

export type EventHandlerDeps = {
  // State queries
  getAgentRunId: (agentId: string) => string | null

  // Dispatchers (to Zustand stores — injected from apps/web)
  dispatchIntent: (intent: EventIntent) => void
  queueLivePatch: (agentId: string, patch: AgentStatusPatch, sessionKey?: string) => void
  clearPendingLivePatch: (agentId: string) => void
  appendOutputLines: (agentId: string, lines: string[], sessionKey?: string) => void
  requestHistoryRefresh: (agentId: string, reason: string) => Promise<void>
  loadSummarySnapshot: () => Promise<void>
  refreshHeartbeatLatest: () => void

  // Timer abstraction (injectable for tests)
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void

  // Optional
  log?: Logger
}

// ── EventHandlerHandle ─────────────────────────────────────────────────────

export type EventHandlerHandle = {
  /** Process intents from the policy layer. Call after derivePolicy(). */
  applyIntents: (intents: EventIntent[], event: ClassifiedEvent) => void
  /** Dispose all timers. Call when gateway disconnects. */
  dispose: () => void
}
