// ─── Observability REST ───────────────────────────────────────
// Read surface over the durable orchestration event log: the raw feed, a single
// reconstructed trace, the harness-bug error query (the taxonomy alert), the
// fleet-health triage view, and the graph projection. Observability is always on
// (no feature gate) — these handlers serve unconditionally. The agent-readable
// "why did the previous agent stop / errors in the last 30 min" queries are these
// same endpoints.

import {
  boardActivityHead,
  listEvents,
  readerLastRead,
  type DbOrchestrationEvent,
} from '@clawboo/db'
import {
  projectFleetHealth,
  projectGraph,
  summarizeMetrics,
  type OrchestrationEvent,
  type OrchestrationEventKind,
} from '@clawboo/obs'
import type { Request, Response } from 'express'

import { readerOf } from '../lib/boardReader'
import { getDb } from '../lib/db'
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

/** `kinds=a,b`: the kinds to match, or undefined (every kind) when none are named. */
function kindsParam(v: unknown): OrchestrationEventKind[] | undefined {
  const kinds = strParam(v)
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean) as OrchestrationEventKind[] | undefined
  return kinds && kinds.length ? kinds : undefined
}

/** A `seq` cursor, or undefined when the value is absent, malformed or negative. */
function seqParam(v: unknown): number | undefined {
  const raw = strParam(v)
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Clamp a caller-supplied row cap to `[1, DASHBOARD_EVENT_WINDOW]`, or undefined
 * to take the data layer's default. Forwarding the raw value let a single
 * request drain a table nothing prunes: SQLite reads a NEGATIVE limit as
 * unbounded, so `?limit=-1` returned every row (measured: 1M rows in ~2.9s) on
 * the synchronous connection that also serves the event loop, then redacted all
 * of them on the way out.
 */
function parseLimit(v: unknown): number | undefined {
  const raw = strParam(v)
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return Math.min(Math.max(Math.trunc(n), 1), DASHBOARD_EVENT_WINDOW)
}

// ─── The dashboard read window ───────────────────────────────────────────────
// Fleet health and the graph projection fold a WINDOW of the log, not the whole
// log: `orchestration_events` is append-only and nothing prunes it, so an
// unbounded read is not an option. The window must be the most RECENT rows.
//
// `listEvents` defaults to `seq ASC`, the causal replay order the reducers need,
// so a `limit` with no `order` silently selects the OLDEST N rows. That is a
// freeze, not an error: past N events both dashboards would pin themselves to
// the first N events the database ever recorded and never reflect current state
// again. Read `desc` to select the recent window, then reverse it so
// `projectFleetHealth` / `projectGraph` still fold chronologically (they are
// order-sensitive: fed newest-first, an `execution_completed` would be seen
// before its `execution_started` and every agent would read as `working`).
//
// The direction also decides which way a CUT pair can lie, and the two are not
// symmetric. A completion always carries a higher `seq` than its start, so a
// trailing window can only ever drop the START, which `Math.max(0, open - 1)`
// clamps to `idle`: it can under-report a still-open execution but never invent
// one. A leading window drops the COMPLETION instead, leaving `open` stuck at 1
// with a stale `lastEventTs`, which is why the old read did not merely freeze,
// it reported healthy agents as permanent zombies. A missed zombie is the safe
// way to be wrong here, and the stuck execution behind it is still reaped by the
// board's orphan reconciliation regardless of what this view shows.
export const DASHBOARD_EVENT_WINDOW = 5000

/**
 * The most recent `DASHBOARD_EVENT_WINDOW` events for the requested scope, in
 * chronological (`seq ASC`) order. Shared by both dashboard handlers so the two
 * cannot drift apart on ordering again. Query: `teamId?`.
 *
 * A `since` (ms) narrowing filter is deliberately NOT offered here, unlike on
 * `/api/obs/events`: no index leads with `ts`, so a window matching fewer rows
 * than the limit must scan the whole never-pruned table to prove none remain,
 * and this read sits on a synchronous 5-second poll. `teamId` rides
 * `idx_orch_events_team_seq`, so scoping by team stays an index seek.
 */
function readRecentEvents(req: Request): OrchestrationEvent[] {
  return listEvents(getDb(), {
    teamId: strParam(req.query['teamId']),
    order: 'desc',
    limit: DASHBOARD_EVENT_WINDOW,
  })
    .reverse()
    .map(toEvent)
}

// ─── GET /api/obs/stream ─────────────────────────────────────────────────────
// SSE live-tail of the event log, scoped by team / task / agent and narrowed to
// `kinds` when given. A short-interval DB-tail keyed on the monotonic `seq`
// cursor: cross-process-correct (catches stdio-bin writes too) and indexed.
// Resume via the EventSource `Last-Event-ID` header, `?afterSeq=<seq>` (the name
// `/api/obs/events` uses) or `?since=<seq>`; the first valid one wins, so a
// malformed header falls back to the query. Note `since` is a `seq` here but a
// wall-clock time on `/api/obs/events`.
//
// `kinds` filters in SQL, so a client following only approvals neither receives
// every tool call and chat post nor waits behind them after a reconnect.
// Redaction-on-display reuses the read-feed masker.
//
// `?activity=1` also sends an `activity` event when the board's record of task
// changes moves, or when this person marks something read in another browser, and
// once on connecting, so a client that reconnects after a long sleep catches up.
// That record is written by triggers, so this covers the writes that leave no event
// row (an agent's comment through its task tool). No `id:` line: it never moves the
// resume cursor.
const STREAM_POLL_MS = 750
const STREAM_KEEPALIVE_MS = 20_000
const STREAM_BATCH = 500

export function obsStreamGET(req: Request, res: Response): void {
  const filter = {
    teamId: strParam(req.query['teamId']),
    taskId: strParam(req.query['taskId']),
    agentId: strParam(req.query['agentId']),
    kinds: kindsParam(req.query['kinds']),
  }
  let cursor =
    seqParam(req.headers['last-event-id']) ??
    seqParam(req.query['afterSeq']) ??
    seqParam(req.query['since']) ??
    0
  const wantsActivity = req.query['activity'] === '1'
  const reader = readerOf(req)
  let lastActivity = ''

  // Resolve the shared connection BEFORE advertising success: a failure here
  // must surface as a real error response, not a 200 plus a ': connected'
  // marker the client has already been told to trust.
  const db = getDb()

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  res.flushHeaders?.()

  let closed = false
  const poll = (): void => {
    if (closed) return
    try {
      // The head is read BEFORE the tail. SQLite has one writer at a time and a
      // writer holds its lock from the insert that allocates a `seq` to its
      // commit, so every row at or below this head is already visible below.
      const head = listEvents(db, { order: 'desc', limit: 1 })[0]?.seq ?? 0
      const rows = listEvents(db, {
        ...filter,
        afterSeq: cursor,
        order: 'asc',
        limit: STREAM_BATCH,
      })
      for (const r of rows) {
        if (r.seq > cursor) cursor = r.seq
        const safe = JSON.stringify({ ...r, data: redactJsonString(r.data) })
        res.write(`id: ${r.seq}\n`)
        res.write(`data: ${safe}\n\n`)
      }
      // A short read was complete, so nothing else in scope sits at or below the
      // head: move past it. Otherwise a scope that rarely matches (`kinds` within
      // a team, a quiet agent) rescans every row since its last match each poll.
      if (rows.length < STREAM_BATCH && head > cursor) cursor = head
      if (wantsActivity) {
        const activity = JSON.stringify({
          seq: boardActivityHead(db),
          read: readerLastRead(db, reader),
        })
        if (activity !== lastActivity) {
          lastActivity = activity
          res.write(`event: activity\ndata: ${activity}\n\n`)
        }
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
    // No DB handle to close: the tail poll reads through the process-wide shared
    // connection (lib/db.ts getDb). Closing it here would kill SQLite for the
    // WHOLE server the moment any one browser tab drops its stream.
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

// ─── GET /api/obs/events ─────────────────────────────────────────────────────
// Query: teamId?, taskId?, kinds=comma,sep, since?(ms), limit?, order=asc|desc
export function obsEventsGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const sinceRaw = strParam(req.query['since'])
    const afterSeqRaw = strParam(req.query['afterSeq'])
    const rows = listEvents(db, {
      teamId: strParam(req.query['teamId']),
      taskId: strParam(req.query['taskId']),
      agentId: strParam(req.query['agentId']),
      traceId: strParam(req.query['traceId']),
      kinds: kindsParam(req.query['kinds']),
      since: sinceRaw ? Number(sinceRaw) : undefined,
      afterSeq: afterSeqRaw ? Number(afterSeqRaw) : undefined,
      limit: parseLimit(req.query['limit']),
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
//
// The ASC window here is DELIBERATE. Do not "fix" it to `desc` by analogy with
// the dashboard handlers below. A trace is a bounded tree, not a growing stream:
// if one ever exceeded the limit, the head (root span first) is the half that
// still reconstructs, whereas the tail would be orphan child spans with no parent.
export function obsTraceGET(req: Request, res: Response): void {
  try {
    const traceId = (req.params['traceId'] as string | undefined) ?? ''
    const events = listEvents(getDb(), { traceId, limit: 5000 })
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
    // Order by `ts`, not `seq`. This is a human-facing "most recent errors"
    // feed on a 5-second poll, and `(kind, ts)` is the only index over `kind`:
    // sorting it by `seq` cannot use that index, so SQLite pushes every error
    // row in the table through a temp B-tree before applying the limit. The
    // cost then grows with accumulated errors rather than with the 500 returned
    // (measured at 100k errors: 57.3 ms sorted by seq, 0.9 ms by ts), which
    // means the error dashboard got slowest exactly when it had most to show.
    const rows = listEvents(getDb(), {
      kinds: ['error'],
      since: sinceRaw ? Number(sinceRaw) : undefined,
      orderBy: 'ts',
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
    const events = readRecentEvents(req)
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
    res.json(projectGraph(readRecentEvents(req)))
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}
