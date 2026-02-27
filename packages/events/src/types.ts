import type { AgentStatus, ConnectionStatus, EventFrame } from '@clawboo/gateway-client'
import type { Logger } from '@clawboo/logger'

// ── Chat and Agent event payloads ──────────────────────────────────────────

export type ChatState = 'delta' | 'final' | 'aborted' | 'error'
export type LifecyclePhase = 'start' | 'end' | 'error'

export type ChatEventPayload = {
  runId: string
  sessionKey: string
  state: ChatState
  seq?: number
  stopReason?: string
  message?: unknown // raw message object from gateway
  errorMessage?: string
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

// ── Lifecycle transition ───────────────────────────────────────────────────

export type LifecycleTransition =
  | { kind: 'start'; patch: AgentStatusPatch; clearRunTracking: false }
  | { kind: 'terminal'; patch: AgentStatusPatch; clearRunTracking: true }
  | { kind: 'ignore' }

// ── EventPlane ─────────────────────────────────────────────────────────────

export type EventPlane = 'work' | 'agent' | 'trust'

// ── EventIntent — typed discriminated union ────────────────────────────────

export type EventIntent =
  // Work plane — streaming (RAF-batched)
  | { kind: 'queueLivePatch'; plane: 'work'; agentId: string; patch: AgentStatusPatch }
  | { kind: 'clearPendingLivePatch'; plane: 'work'; agentId: string }
  // Work plane — terminal (immediate)
  | {
      kind: 'commitChat'
      plane: 'work'
      agentId: string
      patch: AgentStatusPatch
      outputLines: string[]
    }
  // Agent plane
  | { kind: 'updateAgentStatus'; plane: 'agent'; agentId: string; patch: AgentStatusPatch }
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
  getConnectionStatus: () => ConnectionStatus
  getAgentRunId: (agentId: string) => string | null

  // Dispatchers (to Zustand stores — injected from apps/web)
  dispatchIntent: (intent: EventIntent) => void
  queueLivePatch: (agentId: string, patch: AgentStatusPatch) => void
  clearPendingLivePatch: (agentId: string) => void
  appendOutputLines: (agentId: string, lines: string[]) => void
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
