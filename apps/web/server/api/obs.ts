// ─── Observability REST ───────────────────────────────────────
// Read surface over the durable orchestration event log: the raw feed, a single
// reconstructed trace, the harness-bug error query (the taxonomy alert), the
// fleet-health triage view, and the graph projection. Observability is always on
// (no feature gate) — these handlers serve unconditionally. The agent-readable
// "why did the previous agent stop / errors in the last 30 min" queries are these
// same endpoints.

import { createDb, listEvents, type DbOrchestrationEvent } from '@clawboo/db'
import {
  projectFleetHealth,
  projectGraph,
  summarizeMetrics,
  type OrchestrationEvent,
  type OrchestrationEventKind,
} from '@clawboo/obs'
import type { Request, Response } from 'express'

import { getDbPath } from '../lib/db'
import { emitEvent } from '../lib/obs/emit'
import { redactJsonString, redactObject, redactValue } from '../lib/redact'

/** Rehydrate a stored row (JSON-string `data`) into the reducer's event shape. */
function toEvent(row: DbOrchestrationEvent): OrchestrationEvent {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    data = {}
  }
  return {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    kind: row.kind as OrchestrationEventKind,
    teamId: row.teamId,
    taskId: row.taskId,
    agentId: row.agentId,
    runtime: row.runtime,
    traceId: row.traceId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    correlationId: row.correlationId,
    tenantId: row.tenantId,
    data,
  }
}

function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ─── POST /api/obs/ingest ────────────────────────────────────────────────────
// Mirror client-observed runtime events (the OpenClaw in-browser path, which the
// server never sees) into the durable log so the activity terminal is uniform
// across runtimes. Restricted to the per-tool kinds the browser legitimately
// observes — board lifecycle events are already emitted server-side by the board
// REST handlers, never accepted here. Best-effort per event (one bad row never
// fails the batch).
const INGEST_KINDS = new Set<OrchestrationEventKind>(['tool_call', 'tool_result', 'error'])
const MAX_INGEST_BATCH = 200

export function obsIngestPOST(req: Request, res: Response): void {
  try {
    const body = req.body as { events?: unknown } | undefined
    const raw = Array.isArray(body?.events) ? body.events : []
    const db = createDb(getDbPath())
    let count = 0
    for (const e of raw.slice(0, MAX_INGEST_BATCH)) {
      if (!e || typeof e !== 'object') continue
      const ev = e as Record<string, unknown>
      const kind = ev['kind']
      if (typeof kind !== 'string' || !INGEST_KINDS.has(kind as OrchestrationEventKind)) continue
      emitEvent(db, {
        kind: kind as OrchestrationEventKind,
        ts: typeof ev['ts'] === 'number' ? (ev['ts'] as number) : undefined,
        teamId: strOrNull(ev['teamId']),
        taskId: strOrNull(ev['taskId']),
        agentId: strOrNull(ev['agentId']),
        runtime: strOrNull(ev['runtime']) ?? 'openclaw',
        data:
          ev['data'] && typeof ev['data'] === 'object'
            ? (ev['data'] as Record<string, unknown>)
            : {},
      })
      count += 1
    }
    res.json({ ok: true, count })
  } catch (err) {
    res.status(400).json({ error: redactValue(String(err)) })
  }
}

// ─── GET /api/obs/stream ─────────────────────────────────────────────────────
// SSE live-tail of the event log, scoped by team / task / agent. A short-interval
// DB-tail keyed on the monotonic `seq` cursor — cross-process-correct (catches
// stdio-bin writes too) and indexed. Resume via the EventSource `Last-Event-ID`
// header or `?since=<seq>`. Redaction-on-display reuses the read-feed masker.
const STREAM_POLL_MS = 750
const STREAM_KEEPALIVE_MS = 20_000

export function obsStreamGET(req: Request, res: Response): void {
  const scope = {
    teamId: strParam(req.query['teamId']),
    taskId: strParam(req.query['taskId']),
    agentId: strParam(req.query['agentId']),
  }
  const lastEventId =
    typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined
  let cursor = Number(lastEventId ?? strParam(req.query['since']))
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  res.flushHeaders?.()

  let closed = false
  const db = createDb(getDbPath())
  const poll = (): void => {
    if (closed) return
    try {
      const rows = listEvents(db, { ...scope, afterSeq: cursor, order: 'asc', limit: 500 })
      for (const r of rows) {
        if (r.seq > cursor) cursor = r.seq
        const safe = JSON.stringify({ ...r, data: redactJsonString(r.data) })
        res.write(`id: ${r.seq}\n`)
        res.write(`data: ${safe}\n\n`)
      }
    } catch {
      /* transient read error — keep the stream alive; retry next tick */
    }
  }
  poll() // flush anything past the cursor immediately
  const pollTimer = setInterval(poll, STREAM_POLL_MS)
  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n')
  }, STREAM_KEEPALIVE_MS)
  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(pollTimer)
    clearInterval(keepalive)
    // Close the per-connection better-sqlite3 handle (createDb opens a FRESH one per
    // SSE stream) so a long-lived/dropped stream doesn't leak a DB handle until GC.
    try {
      db.$client.close()
    } catch {
      /* already closed / never opened */
    }
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

// ─── GET /api/obs/events ─────────────────────────────────────────────────────
// Query: teamId?, taskId?, kinds=comma,sep, since?(ms), limit?, order=asc|desc
export function obsEventsGET(req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())
    const kinds = strParam(req.query['kinds'])
      ?.split(',')
      .map((k) => k.trim())
      .filter(Boolean) as OrchestrationEventKind[] | undefined
    const sinceRaw = strParam(req.query['since'])
    const limitRaw = strParam(req.query['limit'])
    const afterSeqRaw = strParam(req.query['afterSeq'])
    const rows = listEvents(db, {
      teamId: strParam(req.query['teamId']),
      taskId: strParam(req.query['taskId']),
      agentId: strParam(req.query['agentId']),
      traceId: strParam(req.query['traceId']),
      kinds: kinds && kinds.length ? kinds : undefined,
      since: sinceRaw ? Number(sinceRaw) : undefined,
      afterSeq: afterSeqRaw ? Number(afterSeqRaw) : undefined,
      limit: limitRaw ? Number(limitRaw) : undefined,
      order: req.query['order'] === 'desc' ? 'desc' : 'asc',
    })
    // Redact-on-display: mask any credential-shaped key/value in each event's JSON
    // `data` before it reaches the browser (defense in depth atop the storage scrub).
    const events = rows.map((r) => ({ ...r, data: redactJsonString(r.data) }))
    res.json({ events })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// ─── GET /api/obs/traces/:traceId ────────────────────────────────────────────
// One trace = all events sharing the traceId, ordered seq ASC (causal). Renders
// the full multi-agent task (leader → specialists → tools).
export function obsTraceGET(req: Request, res: Response): void {
  try {
    const traceId = (req.params['traceId'] as string | undefined) ?? ''
    const events = listEvents(createDb(getDbPath()), { traceId, limit: 5000 })
    // Metrics are computed from the un-redacted events first, then each event's JSON
    // `data` is redacted for display (numeric cost/token fields survive — see redact.ts).
    const metrics = summarizeMetrics(events.map(toEvent))
    const safeEvents = events.map((r) => ({ ...r, data: redactJsonString(r.data) }))
    res.json({ traceId, events: safeEvents, metrics })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// ─── GET /api/obs/errors ─────────────────────────────────────────────────────
// Query: harnessBug=true (only harness bugs), since?, limit?. The taxonomy alert
// feed — an unknown error class is a harness bug.
export function obsErrorsGET(req: Request, res: Response): void {
  try {
    const sinceRaw = strParam(req.query['since'])
    const rows = listEvents(createDb(getDbPath()), {
      kinds: ['error'],
      since: sinceRaw ? Number(sinceRaw) : undefined,
      order: 'desc',
      limit: 500,
    })
    const errors = rows.map((r) => {
      let d: { errorClass?: string; harnessBug?: boolean; message?: string } = {}
      try {
        d = JSON.parse(r.data) as typeof d
      } catch {
        /* keep defaults */
      }
      return {
        seq: r.seq,
        ts: r.ts,
        taskId: r.taskId,
        agentId: r.agentId,
        runtime: r.runtime,
        errorClass: d.errorClass ?? 'Unknown',
        harnessBug: Boolean(d.harnessBug),
        message: d.message ?? '',
      }
    })
    const filtered =
      req.query['harnessBug'] === 'true' ? errors.filter((e) => e.harnessBug) : errors
    res.json(
      redactObject({
        errors: filtered,
        harnessBugCount: errors.filter((e) => e.harnessBug).length,
      }),
    )
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// ─── GET /api/obs/health ─────────────────────────────────────────────────────
// Fleet-health triage (working / idle / stalled / zombie). Query: teamId?
export function obsHealthGET(req: Request, res: Response): void {
  try {
    const events = listEvents(createDb(getDbPath()), {
      teamId: strParam(req.query['teamId']),
      limit: 5000,
    }).map(toEvent)
    const health = projectFleetHealth(events, Date.now())
    res.json({ agents: [...health.entries()].map(([id, h]) => ({ agentId: id, ...h })) })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

// ─── GET /api/obs/graph ──────────────────────────────────────────────────────
// The event-sourced delegation/status/cost graph projection. Query: teamId?
export function obsGraphGET(req: Request, res: Response): void {
  try {
    const events = listEvents(createDb(getDbPath()), {
      teamId: strParam(req.query['teamId']),
      limit: 5000,
    }).map(toEvent)
    res.json(projectGraph(events))
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
