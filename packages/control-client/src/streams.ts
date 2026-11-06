// The frames of the three resumable event streams, as zod schemas a client can
// validate with. Each stream tails a durable log over Server-Sent Events: a
// stored row goes out as the default `message` event with an `id:` line, so an
// `EventSource` resumes from `Last-Event-ID` after a reconnect (`?since=<id>`
// does the same for a first connect). The chat streams open with a `cursor`
// event carrying the id they start from, so a client that drops before the first
// row still resumes there. Every other named event carries no `id:` line and
// never moves the resume cursor.
//
// The schemas pin field names and base types, not every enum value, so a client
// built against one engine keeps parsing frames from the next. Unknown fields are
// dropped, not rejected. The engine's contract test drives the real streams
// through these, so removing or renaming a field fails it.

import { z } from 'zod'

/** A committed chat turn: the default `message` event on both chat streams. */
export const chatMessageFrameSchema = z.object({
  entryId: z.string(),
  role: z.string(),
  kind: z.string(),
  text: z.string(),
  sessionKey: z.string(),
  runId: z.string().nullable(),
  source: z.string(),
  timestampMs: z.number().nullable(),
  sequenceKey: z.number(),
  confirmed: z.boolean(),
  fingerprint: z.string(),
  /** Set when a routine posted the turn on the person's behalf. */
  origin: z.object({ kind: z.string(), routineId: z.string(), routineName: z.string() }).optional(),
  /** Who sent a user turn, when a sign-in proxy vouched for them. */
  person: z
    .object({ id: z.string(), name: z.string().nullable(), role: z.string().nullable() })
    .optional(),
})
export type ChatMessageFrame = z.infer<typeof chatMessageFrameSchema>

/** Where a chat stream starts (`event: cursor`), sent first on every connect with
 *  the same value as its `id:` line, so an `EventSource` holds a resume point
 *  before any row arrives. A client needs no listener for it. */
export const streamCursorFrameSchema = z.object({ cursor: z.number() })
export type StreamCursorFrame = z.infer<typeof streamCursorFrameSchema>

/** A live token update (`event: delta`). `text` is the whole reply so far, so a
 *  client replaces rather than appends; an empty `text` clears the live card. */
export const chatDeltaFrameSchema = z.object({
  sessionKey: z.string(),
  runId: z.string().nullable(),
  text: z.string(),
})
export type ChatDeltaFrame = z.infer<typeof chatDeltaFrameSchema>

/** An agent's working state (`event: status`). Each stream first replays the
 *  last known status of every agent on its channel, without `roomId`. */
export const agentStatusFrameSchema = z.object({
  agentId: z.string(),
  status: z.enum(['running', 'idle', 'error']),
  roomId: z.string().nullable().optional(),
})
export type AgentStatusFrame = z.infer<typeof agentStatusFrameSchema>

/** Why a task needs a person, attached when a change moves a task's status. */
export const taskAttentionFrameSchema = z.object({
  reason: z.string(),
  failedRuns: z.number(),
  detail: z.string().optional(),
})

/** A board task changed (`event: board`, team chat only). Only `id` is always
 *  present; a client merges the rest into the task it already holds. */
export const boardChangeFrameSchema = z.object({
  id: z.string(),
  identifier: z.string().nullable().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  assigneeAgentId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  summary: z.string().optional(),
  attention: taskAttentionFrameSchema.nullable().optional(),
  roomId: z.string().nullable().optional(),
  /** When the task's check began waiting for the team folder; null when it stopped. */
  checkHeldSince: z.number().nullable().optional(),
})
export type BoardChangeFrame = z.infer<typeof boardChangeFrameSchema>

/** One row of the event log: the default `message` event on the event stream.
 *  `data` stays a JSON string (redacted), so a client parses it itself. */
export const orchestrationEventFrameSchema = z.object({
  seq: z.number(),
  id: z.string(),
  ts: z.number(),
  kind: z.string(),
  teamId: z.string().nullable(),
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
  runtime: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  parentSpanId: z.string().nullable(),
  correlationId: z.string().nullable(),
  data: z.string(),
  tenantId: z.string().nullable(),
  createdAt: z.number(),
})
export type OrchestrationEventFrame = z.infer<typeof orchestrationEventFrameSchema>

/** Where the board's record of changes stands (`seq`) and when this person last
 *  marked something read (`read`): the `activity` event on the event stream, sent
 *  only to a client that asks with `?activity=1`, once on connecting and again when
 *  either moves. It says only that a read of the inbox is worth taking. */
export const boardActivityFrameSchema = z.object({ seq: z.number(), read: z.number() })
export type BoardActivityFrame = z.infer<typeof boardActivityFrameSchema>

/** One resumable stream: its route and the schema of each event it sends. The
 *  `message` event is the stored one, carrying the `id:` a client resumes from. */
export interface ResumableStream {
  method: 'GET'
  path: string
  events: Record<string, z.ZodTypeAny>
}

export const RESUMABLE_STREAMS = {
  teamChat: {
    method: 'GET',
    path: '/api/teams/:id/chat/stream',
    events: {
      cursor: streamCursorFrameSchema,
      message: chatMessageFrameSchema,
      delta: chatDeltaFrameSchema,
      board: boardChangeFrameSchema,
      status: agentStatusFrameSchema,
    },
  },
  agentChat: {
    method: 'GET',
    path: '/api/agents/:agentId/chat/stream',
    events: {
      cursor: streamCursorFrameSchema,
      message: chatMessageFrameSchema,
      delta: chatDeltaFrameSchema,
      status: agentStatusFrameSchema,
    },
  },
  events: {
    method: 'GET',
    path: '/api/obs/stream',
    events: { message: orchestrationEventFrameSchema, activity: boardActivityFrameSchema },
  },
} as const satisfies Record<string, ResumableStream>
