// The orchestration event log — the append-only stream every observability
// surface reads. It is simultaneously (a) the always-on local TRACE store (a
// trace = all events sharing a `traceId`, ordered by `seq`), (b) the GRAPH
// projection source (delegation/status/cost), and (c) the metric + error-taxonomy
// source. Persisted by @clawboo/db's events core (which mirrors governance/audit:
// insert-only, secrets scrubbed). One trace per board task; spans per run/tool.
//
// Design note (validated against many emit sites): the runtime Zod schema
// validates the correlation ENVELOPE strictly and treats `data` as an open object
// (`z.record`), so an emit site can never DROP an event on a minor data-shape
// drift — observability must capture best-effort. The kind→data shapes are
// expressed as TypeScript interfaces (a discriminated union) so producers and the
// projection reducers stay fully typed without risking event loss at the wire.

import { z } from 'zod'

export const ORCHESTRATION_EVENT_KINDS = [
  'task_created',
  'task_claimed',
  'status_changed',
  'comment_added',
  'dep_linked',
  'execution_started',
  'execution_completed',
  'tool_call',
  'tool_result',
  'cost',
  'approval_requested',
  'approval_resolved',
  'error',
  'span_start',
  'span_end',
  'session_rotated',
  'routine_fired',
  'routine_dispatched',
  'routine_completed',
  'routine_error',
  'team_chat_post',
  'speaker_selected',
  'turn_bound_hit',
] as const

export type OrchestrationEventKind = (typeof ORCHESTRATION_EVENT_KINDS)[number]

export const orchestrationEventKindSchema = z.enum(ORCHESTRATION_EVENT_KINDS)

/**
 * The correlation envelope. `seq` is assigned atomically by SQLite on insert
 * (cross-process monotonic) and is therefore optional on the producer side.
 * `traceId` ties every span/event of one board task together; `spanId` /
 * `parentSpanId` form the span tree (run span, tool sub-spans).
 */
export const orchestrationEventSchema = z.object({
  id: z.string(),
  seq: z.number().int().optional(),
  ts: z.number().int(),
  kind: orchestrationEventKindSchema,
  teamId: z.string().nullish(),
  taskId: z.string().nullish(),
  agentId: z.string().nullish(),
  runtime: z.string().nullish(),
  traceId: z.string().nullish(),
  spanId: z.string().nullish(),
  parentSpanId: z.string().nullish(),
  correlationId: z.string().nullish(),
  tenantId: z.string().nullish(),
  // Open by design — never drop an event on a data-shape mismatch.
  data: z.record(z.string(), z.unknown()).default({}),
})

export type OrchestrationEventInput = z.input<typeof orchestrationEventSchema>
export type OrchestrationEvent = z.infer<typeof orchestrationEventSchema>

/** Validate (and default `data`) an event before it is persisted. */
export function parseOrchestrationEvent(value: unknown): OrchestrationEvent {
  return orchestrationEventSchema.parse(value)
}

// ── Kind → data shapes (typed producers + reducers; not enforced at the wire) ──

export interface TaskCreatedData {
  title?: string | null
  status?: string
  parentTaskId?: string | null
  priority?: string | null
}
export interface TaskClaimedData {
  assigneeAgentId?: string | null
  assigneeRuntime?: string | null
}
export interface StatusChangedData {
  from?: string | null
  to: string
}
export interface CommentAddedData {
  authorType?: string
  body?: string
}
export interface DepLinkedData {
  dependsOnTaskId: string
}
export interface ExecutionStartedData {
  execId: string
  executorType?: string
  runReason?: string | null
}
export interface ExecutionCompletedData {
  execId: string
  status: string
  costUsd?: number | null
  inputTokens?: number
  outputTokens?: number
  error?: string | null
}
export interface ToolCallData {
  toolCallId: string
  name: string
  input?: unknown
}
export interface ToolResultData {
  toolCallId: string
  name: string
  isError: boolean
  output?: string
}
export interface CostData {
  costUsd?: number | null
  inputTokens?: number
  outputTokens?: number
  model?: string | null
}
export interface ApprovalRequestedData {
  approvalId?: string
  scopeKey?: string
  kind?: string
}
export interface ApprovalResolvedData {
  approvalId?: string
  decision?: string
}
export interface ErrorEventData {
  code?: string | null
  message: string
  errorClass: string
  harnessBug: boolean
  fatal?: boolean
}
export interface SpanStartData {
  name: string
  spanKind?: 'task' | 'tool' | 'run'
}
export interface SpanEndData {
  name: string
  status?: 'ok' | 'error'
  durationMs?: number
}
export interface SessionRotatedData {
  /** Predecessor session stream key. */
  from: string
  /** Successor session stream key. */
  to: string
  /** Why the session rotated. */
  reason: 'max_turns' | 'context_watermark'
  /** Tokens the predecessor consumed before rotating. */
  tokensUsed?: number
  /** 1-based rotation index within the task's run chain. */
  rotationIndex?: number
}

export interface RoutineFiredData {
  /** The scheduled_runs ledger row that fired. */
  scheduledRunId: string
  cronSpec: string
  /** The firing owner of record ('clawboo' for the Routines engine). */
  scheduledBy: string
}
export interface RoutineDispatchedData {
  scheduledRunId: string
  /** The board task the fire materialized (or the bound existing task). */
  taskId: string
  runtime: string
  /** Which wake-bridge branch carried the dispatch. */
  dispatchPath: 'one-shot' | 'connected' | 'human'
}
export interface RoutineCompletedData {
  scheduledRunId: string
  taskId?: string | null
  /** Outcome status recorded on the ledger row. */
  status: string
  /** The re-armed next fire time; null = disarmed (spent once@ / errored). */
  nextRunAt?: number | null
}
export interface RoutineErrorData {
  scheduledRunId: string
  code?: string | null
  message: string
}

export interface TeamChatPostData {
  /** The room the post landed in (one room per team by default). */
  roomId: string
  /** Per-room monotonic ordering key assigned at write time. */
  seq: number
  /** Author identity, resolved from the MCP connection — never tool args. */
  authorAgentId: string
  /** 'peer' = a teammate's post; 'system' = board-mutation narration; 'user'. */
  postKind: 'peer' | 'system' | 'user'
}
export interface SpeakerSelectedData {
  roomId: string
  /** The agent the speaker-selection policy nominated to talk next. */
  speakerAgentId: string
  /** How the next speaker was chosen. */
  policy: 'leader-nominated' | 'round-robin'
  /** 1-based turn index within the current bounded exchange. */
  exchangeTurn: number
}
export interface TurnBoundHitData {
  roomId: string
  /** Why the exchange ended. */
  reason: 'max_turns' | 'no_pending_obligation'
  /** The cap that bounded the exchange. */
  maxExchangeTurns: number
  /** How many peer turns the exchange actually ran. */
  turnsTaken: number
}

export interface KindToData {
  task_created: TaskCreatedData
  task_claimed: TaskClaimedData
  status_changed: StatusChangedData
  comment_added: CommentAddedData
  dep_linked: DepLinkedData
  execution_started: ExecutionStartedData
  execution_completed: ExecutionCompletedData
  tool_call: ToolCallData
  tool_result: ToolResultData
  cost: CostData
  approval_requested: ApprovalRequestedData
  approval_resolved: ApprovalResolvedData
  error: ErrorEventData
  span_start: SpanStartData
  span_end: SpanEndData
  session_rotated: SessionRotatedData
  routine_fired: RoutineFiredData
  routine_dispatched: RoutineDispatchedData
  routine_completed: RoutineCompletedData
  routine_error: RoutineErrorData
  team_chat_post: TeamChatPostData
  speaker_selected: SpeakerSelectedData
  turn_bound_hit: TurnBoundHitData
}

/** A producer-side typed event: the envelope minus the server-assigned bits, plus
 *  a kind-specific `data`. The emit helper fills `id`/`ts`; SQLite fills `seq`. */
export type TypedEvent<K extends OrchestrationEventKind = OrchestrationEventKind> = {
  kind: K
  data: KindToData[K]
} & Omit<Partial<OrchestrationEvent>, 'kind' | 'data'>
