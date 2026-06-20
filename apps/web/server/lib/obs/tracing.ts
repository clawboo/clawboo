// Trace a board-task run: one task span per run (events `span_start`/`span_end`
// into the always-on event-log trace store + a real OTel span when the bridge is
// active), with tool calls recorded as child spans. `withTaskSpan` hands the body
// a SpanCtx (traceId + spanId) so the runner's own emits (cost/tool/error) nest
// under the run.

import { randomUUID } from 'node:crypto'

import type { ClawbooDb } from '@clawboo/db'

import { emitEvent } from './emit'
import { formatTraceparent, parseTraceparent, rootSpanIdFor, spanIdFor, traceIdFor } from './ids'
import { getObsTracer, initOtel } from './otel'

export interface SpanCtx {
  /** Shared across every run of one mission → one trace. */
  traceId: string
  /** This run's span id (deterministic from its task id) — children set it as `parentSpanId`. */
  spanId: string
  /** This run's parent span id — the parent run, or the synthetic mission root. */
  parentSpanId: string
  /** This run's W3C traceparent — hand to a child run (e.g. via `RunTaskInput.parentTraceparent`)
   *  to nest it under this span. */
  traceparent: string
}

export interface TaskSpanMeta {
  db: ClawbooDb
  name: string
  /** The mission-root id — the shared trace key. A fresh uuid when omitted. */
  traceId?: string | null
  taskId?: string | null
  teamId?: string | null
  agentId?: string | null
  runtime?: string | null
  correlationId?: string | null
  /** The parent run's span id (the board ancestor chain provides it — see ./ids). */
  parentSpanId?: string | null
  /** A parent run's W3C traceparent (cross-process chaining); takes precedence over parentSpanId. */
  parentTraceparent?: string | null
}

export async function withTaskSpan<T>(
  meta: TaskSpanMeta,
  fn: (ctx: SpanCtx) => Promise<T>,
): Promise<T> {
  await initOtel()
  const traceKey = meta.traceId && meta.traceId.length > 0 ? meta.traceId : randomUUID()
  const traceId = traceKey // the event-log trace id stays the raw mission-root key
  // Deterministic span id from this run's task id → a child run can reference its
  // parent run's span id by deriving it from the parent task id (zero threading).
  const spanId = spanIdFor(meta.taskId ?? randomUUID())
  const parsedParent = parseTraceparent(meta.parentTraceparent)
  const parentSpanId =
    parsedParent?.spanId ??
    (meta.parentSpanId && meta.parentSpanId.length > 0
      ? meta.parentSpanId
      : rootSpanIdFor(traceKey))
  // The OTel trace id (hex). A cross-process parent's traceparent wins so the whole
  // chain shares one trace; otherwise derive it from the mission root.
  const otelTraceId = parsedParent?.traceId ?? traceIdFor(traceKey)
  const ctx: SpanCtx = {
    traceId,
    spanId,
    parentSpanId,
    traceparent: formatTraceparent(otelTraceId, spanId),
  }
  const startedAt = Date.now()

  emitEvent(meta.db, {
    kind: 'span_start',
    traceId,
    spanId,
    parentSpanId,
    taskId: meta.taskId ?? null,
    teamId: meta.teamId ?? null,
    agentId: meta.agentId ?? null,
    runtime: meta.runtime ?? null,
    correlationId: meta.correlationId ?? null,
    data: { name: meta.name, spanKind: 'task' },
  })

  const finish = (status: 'ok' | 'error'): void => {
    emitEvent(meta.db, {
      kind: 'span_end',
      traceId,
      spanId,
      parentSpanId,
      taskId: meta.taskId ?? null,
      teamId: meta.teamId ?? null,
      agentId: meta.agentId ?? null,
      runtime: meta.runtime ?? null,
      data: { name: meta.name, status, durationMs: Date.now() - startedAt },
    })
  }

  const tracer = getObsTracer()
  if (tracer) {
    return tracer.startActiveSpan(
      meta.name,
      { traceId: otelTraceId, spanId: parentSpanId },
      async (span) => {
        try {
          const r = await fn(ctx)
          finish('ok')
          return r
        } catch (e) {
          span.setError(e instanceof Error ? e.message : String(e))
          finish('error')
          throw e
        } finally {
          span.end()
        }
      },
    )
  }

  try {
    const r = await fn(ctx)
    finish('ok')
    return r
  } catch (e) {
    finish('error')
    throw e
  }
}

/** Record a tool call as an OTel child span under the active run span (best-effort;
 *  the event-log tool_call/tool_result events are the always-on representation). */
export function recordToolSpan(name: string, ok: boolean): void {
  getObsTracer()?.recordChildSpan(name, ok)
}
