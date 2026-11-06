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
  // ─── Connector / grant plane ──────────────────────────────────────────────
  // A grant DECISION is its own kind rather than a field on `tool_call`, because
  // the interesting ones are the calls that never happened: a denial produces no
  // tool_call at all, so folding it in would make the deny path invisible in the
  // very stream you would use to audit it.
  'grant_decision',
  'connector_health',
  // ─── Saved wakes ──────────────────────────────────────────────────────────
  // Something happened on a task and its agent is to hear it. Skips are their own
  // kind because they are the case worth finding: a wake that did not start a run,
  // and why.
  'task_wake_recorded',
  'task_wake_skipped',
  'task_wake_given_up',
  'task_braked',
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

/**
 * A person a sign-in proxy vouched for, with a signed token the server verified
 * (the shape of @clawboo/protocol's PersonRef). Events a person's request caused
 * carry it as `person`; absent means nothing vouched for who made the request.
 */
export interface EventPerson {
  id: string
  name: string | null
  role: string | null
}
export interface TaskCreatedData {
  title?: string | null
  status?: string
  parentTaskId?: string | null
  priority?: string | null
  person?: EventPerson
}
export interface TaskClaimedData {
  person?: EventPerson
  assigneeAgentId?: string | null
  assigneeRuntime?: string | null
}
export interface StatusChangedData {
  from?: string | null
  to: string
  /** `person` for a person's move (the board, the task drawer). */
  by?: 'person'
  person?: EventPerson
}
export interface CommentAddedData {
  authorType?: string
  body?: string
  person?: EventPerson
}
export interface TaskWakeRecordedData {
  /** `TaskWakeReason` in @clawboo/board-core. */
  reason: string
}
export interface TaskWakeSkippedData {
  wakeId: string
  /** Why it is still waiting (`WakeSkipReason` in @clawboo/board-core), or `finished`
   *  when the task closed first and the wake was settled. */
  reason: string
  /** Why it was saved. */
  wakeReason: string
}
export interface TaskWakeGivenUpData {
  wakeId: string
  wakeReason: string
  replays: number
}
export interface TaskBrakedData {
  /** Runs in a row with no visible progress. */
  runs: number
  /** When the next automatic start may happen (epoch ms). */
  until: number
}
export interface DepLinkedData {
  dependsOnTaskId: string
  person?: EventPerson
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
  /**
   * Attribution. Optional so every existing producer compiles unchanged.
   *
   * Without these the only join key is the tool NAME, which is unprefixed and
   * collides across servers by design, so a UI could not tell which connector
   * a call belonged to, and "which grants fired overnight" had no answer.
   */
  grantId?: string | null
  connectorId?: string | null
}

export interface GrantDecisionData {
  /** `allow` | `require_approval` | `deny`: the verdict `decideGrant` returned. */
  decision: string
  /** The typed reason, e.g. `tool-not-in-scope`, `lethal-trifecta`. */
  reason?: string | null
  grantId?: string | null
  connectorId?: string | null
  toolName: string
  /** Set when a standing rule short-circuited the decision. */
  ruleId?: string | null
}

export interface ConnectorHealthData {
  connectorId: string
  /** Mirrors `CapabilityHealth`: unknown | ok | needs-auth | degraded | error | drift. */
  health: string
  /** One scrubbed line. Never a secret, never a stack. */
  detail?: string | null
  /** Consecutive failures behind a degraded/error transition. */
  failures?: number
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
/**
 * One approval opened. Names the call and never carries its arguments: this log
 * is never pruned and every Activity feed reads it, so the arguments (a shell
 * command, a message body) stay on the approval row behind the REST route.
 */
export interface ApprovalRequestedData {
  approvalId?: string
  scopeKey?: string
  /** Who holds the call: `tool` (clawboo's own broker) or `exec` (the OpenClaw Gateway). */
  kind?: string
  toolName?: string
  /** The server's reading of the tool: `read` | `write` | `destructive`. */
  toolClass?: string | null
  grantId?: string | null
  connectorId?: string | null
  /** When the card stops being answerable (epoch ms). */
  expiresAt?: number
}
export interface ApprovalResolvedData {
  approvalId?: string
  /** `allow_once` | `allow_always` | `deny` | `expired`. */
  decision?: string
  kind?: string
  toolName?: string
  /** Who answered, when a sign-in proxy vouched for them. Absent otherwise. */
  resolvedBy?: EventPerson
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
  /** The board task the fire materialized (or the bound existing task). Null for
   *  a team routine, which posts to the team chat instead of creating a task. */
  taskId: string | null
  /** The runtime that ran the fire; null when a team routine's lead had none. */
  runtime: string | null
  /** Which wake-bridge branch carried the dispatch. */
  dispatchPath: 'one-shot' | 'connected' | 'human' | 'team-chat'
  /** Team routines: the agent the message went to (the team's lead). */
  targetAgentId?: string | null
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
  /** The class the failure was filed under, when the fire ran far enough to have one. */
  errorClass?: string
  /** The routine stopped on this failure. False: it keeps its schedule, since the
   *  failure may pass by itself. */
  stopped?: boolean
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
  grant_decision: GrantDecisionData
  connector_health: ConnectorHealthData
  task_wake_recorded: TaskWakeRecordedData
  task_wake_skipped: TaskWakeSkippedData
  task_wake_given_up: TaskWakeGivenUpData
  task_braked: TaskBrakedData
}

/** A producer-side typed event: the envelope minus the server-assigned bits, plus
 *  a kind-specific `data`. The emit helper fills `id`/`ts`; SQLite fills `seq`. */
export type TypedEvent<K extends OrchestrationEventKind = OrchestrationEventKind> = {
  kind: K
  data: KindToData[K]
} & Omit<Partial<OrchestrationEvent>, 'kind' | 'data'>
