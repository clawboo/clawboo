// Live tail of the durable obs event log, scoped to a task / agent / team (or
// global when no scope is given). Backfills the recent window via
// `GET /api/obs/events`, then opens an `EventSource` to `/api/obs/stream` and
// appends live events de-duped by the monotonic `seq`. EventSource auto-reconnects
// and resumes from the last `seq` via its `Last-Event-ID` header.

import { useEffect, useRef, useState } from 'react'

/** One row of the obs event log (server-redacted `data`, parsed to an object). */
export interface ObsLogEvent {
  id: string
  seq: number
  ts: number
  kind: string
  teamId: string | null
  taskId: string | null
  agentId: string | null
  runtime: string | null
  traceId: string | null
  spanId?: string | null
  data: Record<string, unknown>
}

export interface ObsScope {
  taskId?: string
  agentId?: string
  teamId?: string
}

export interface ObsStreamState {
  events: ObsLogEvent[]
  /** The SSE connection is currently open (the tail is live). */
  live: boolean
  /** The initial backfill is in flight. */
  loading: boolean
  error: string | null
}

const MAX_EVENTS = 600 // bound the in-memory tail
const DEFAULT_BACKFILL = 200

function scopeParams(scope: ObsScope): URLSearchParams {
  const p = new URLSearchParams()
  if (scope.taskId) p.set('taskId', scope.taskId)
  if (scope.agentId) p.set('agentId', scope.agentId)
  if (scope.teamId) p.set('teamId', scope.teamId)
  return p
}

function parseRow(row: Record<string, unknown>): ObsLogEvent {
  let data: Record<string, unknown> = {}
  const raw = row['data']
  try {
    data =
      typeof raw === 'string'
        ? (JSON.parse(raw) as Record<string, unknown>)
        : ((raw as Record<string, unknown>) ?? {})
  } catch {
    data = {}
  }
  return { ...(row as unknown as ObsLogEvent), data }
}

export function useObsStream(
  scope: ObsScope,
  opts?: { limit?: number; enabled?: boolean },
): ObsStreamState {
  const [events, setEvents] = useState<ObsLogEvent[]>([])
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const enabled = opts?.enabled ?? true
  const limit = opts?.limit ?? DEFAULT_BACKFILL
  // Stable subscription key — re-subscribe only when the scope actually changes.
  const scopeKey = `${scope.taskId ?? ''}|${scope.agentId ?? ''}|${scope.teamId ?? ''}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  useEffect(() => {
    if (!enabled) {
      // Drop any prior rows so a re-enable backfills fresh (and a closed/hidden
      // host doesn't retain a stale tail in memory).
      setLoading(false)
      setLive(false)
      setEvents([])
      return
    }
    let cancelled = false
    const seen = new Set<number>()
    let maxSeq = 0
    let es: EventSource | null = null
    // Abort the in-flight backfill fetch on unmount so no request escapes the
    // component lifecycle (keeps strict-MSW tests clean + avoids a late setState).
    const backfillAbort = new AbortController()

    setLoading(true)
    setError(null)
    setEvents([])
    setLive(false)

    const base = scopeParams(scopeRef.current)

    const openStream = (): void => {
      // No EventSource (SSR / test env) → backfill only, no live tail.
      if (typeof EventSource === 'undefined') return
      const sp = new URLSearchParams(base)
      sp.set('since', String(maxSeq))
      es = new EventSource(`/api/obs/stream?${sp.toString()}`)
      es.onopen = () => {
        if (!cancelled) setLive(true)
      }
      es.onerror = () => {
        // EventSource reconnects on its own (resuming via Last-Event-ID).
        if (!cancelled) setLive(false)
      }
      es.onmessage = (e) => {
        if (cancelled) return
        try {
          const row = parseRow(JSON.parse(e.data) as Record<string, unknown>)
          if (seen.has(row.seq)) return
          seen.add(row.seq)
          if (row.seq > maxSeq) maxSeq = row.seq
          setEvents((prev) => {
            const next = [...prev, row]
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
          })
        } catch {
          /* ignore a malformed frame */
        }
      }
    }

    void (async () => {
      try {
        const bp = new URLSearchParams(base)
        bp.set('order', 'asc')
        bp.set('limit', String(limit))
        const r = await fetch(`/api/obs/events?${bp.toString()}`, { signal: backfillAbort.signal })
        if (!cancelled && r.ok) {
          const body = (await r.json()) as { events?: Record<string, unknown>[] }
          const rows = (body.events ?? []).map(parseRow)
          for (const row of rows) {
            seen.add(row.seq)
            if (row.seq > maxSeq) maxSeq = row.seq
          }
          setEvents(rows.slice(-MAX_EVENTS))
        }
      } catch (err) {
        // An AbortError from unmount is expected — not a real error to surface.
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
      if (!cancelled) openStream()
    })()

    return () => {
      cancelled = true
      backfillAbort.abort()
      es?.close()
    }
  }, [scopeKey, enabled, limit])

  return { events, live, loading, error }
}
