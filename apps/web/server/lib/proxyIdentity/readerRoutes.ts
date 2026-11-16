// The reads a reader key's token may make, and nothing else (in releases after
// 0.8.0). A program running beside the server signs them with its own key
// (proxyIdentityReaderPublicKey); they are no person's act, so they never set a
// person and never pass the person check.
//
// Each is a GET (or HEAD) on one exact path with one exact query shape. Every
// reading of the path (see @clawboo/gateway-proxy's request-path) must be the
// route's path itself, so no letter case, trailing slash, dot segment or
// backslash reaches another route. The query is checked twice: as the URL
// parser reads it and as the route's handler reads it (Express's `req.query`),
// and both must be exactly the shape below: no key left out, none added, none
// repeated. Anything else answers 403 with `"error": "role"` and
// `"reason": "reader"` before the token is checked (lane.ts), so a refused
// request never spends one.
//
// Each read is workspace-wide by design: no team scoping applies to it, with or
// without roles. The two event-log reads are limited to the approval kinds, the
// only part of the log the reader may see.

import type { IncomingMessage } from 'node:http'

import { LIVENESS_PATH, requestPathReadings } from '@clawboo/gateway-proxy'

/** The only event kinds a reader may read, in the one order it sends them. */
export const READER_EVENT_KINDS = 'approval_requested,approval_resolved'

/** A `seq` cursor as a reader sends it: digits only. */
const SEQ = /^\d{1,16}$/

type Query = ReadonlyMap<string, string>

interface ReaderRoute {
  path: string
  /** True when the query (and, for the event stream, its resume header) is
   *  exactly this read's shape. */
  shape: (query: Query, req: IncomingMessage) => boolean
}

/** True when `query` holds exactly these keys with these values. */
function exactly(query: Query, want: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(want)
  return query.size === keys.length && keys.every((k) => query.get(k) === want[k])
}

/** True when every key of `query` is one of `allowed`. */
function onlyKeys(query: Query, allowed: readonly string[]): boolean {
  return [...query.keys()].every((k) => allowed.includes(k))
}

const none = (query: Query): boolean => query.size === 0

/** The reads, in the order the docs list them. */
export const READER_ROUTES: readonly ReaderRoute[] = [
  // Whether the server is up. Open to anyone, so a reader token is never needed
  // here, but one that is sent is checked like any other.
  { path: LIVENESS_PATH, shape: none },
  // The running version, without asking the npm registry.
  { path: '/api/system/self-version', shape: (q) => exactly(q, { local: '1' }) },
  { path: '/api/runtimes', shape: none },
  { path: '/api/teams', shape: none },
  { path: '/api/agents', shape: none },
  // The approvals waiting for an answer.
  { path: '/api/tools/approvals', shape: (q) => exactly(q, { status: 'pending' }) },
  // The live tail of approvals asked and answered, resumed from a `seq`: the
  // `afterSeq` query, or an EventSource's `Last-Event-ID` header in its place.
  {
    path: '/api/obs/stream',
    shape: (q, req) => {
      if (q.get('kinds') !== READER_EVENT_KINDS || !onlyKeys(q, ['kinds', 'afterSeq'])) {
        return false
      }
      const after = q.get('afterSeq')
      if (after !== undefined && !SEQ.test(after)) return false
      const last = req.headers['last-event-id']
      if (last !== undefined && (typeof last !== 'string' || !SEQ.test(last))) return false
      return after !== undefined || last !== undefined
    },
  },
  // The newest (or oldest) approval event, one row.
  {
    path: '/api/obs/events',
    shape: (q) => {
      if (q.get('kinds') !== READER_EVENT_KINDS || q.get('limit') !== '1') return false
      if (!onlyKeys(q, ['kinds', 'limit', 'order'])) return false
      const order = q.get('order')
      return order === undefined || order === 'asc' || order === 'desc'
    },
  },
]

/** The raw query of a request target, without the `?`: '' when there is none. */
function rawQuery(url: string): string {
  const start = url.indexOf('?')
  if (start === -1) return ''
  const end = url.indexOf('#', start)
  return url.slice(start + 1, end === -1 ? undefined : end)
}

/** The query as the URL parser reads it, or null when a key repeats. */
function parsedQuery(url: string): Map<string, string> | null {
  const out = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(rawQuery(url))) {
    if (out.has(key)) return null
    out.set(key, value)
  }
  return out
}

/** The query as the route's handler reads it (Express's `req.query`): null when a
 *  value is not one string, undefined outside Express. */
function routedQuery(req: IncomingMessage): Map<string, string> | null | undefined {
  let query: unknown
  try {
    query = (req as { query?: unknown }).query
  } catch {
    return null
  }
  if (query === undefined) return undefined
  if (!query || typeof query !== 'object') return null
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') return null
    out.set(key, value)
  }
  return out
}

/** True when the request is one of the reads on the list, exactly. */
export function readerMayRead(req: IncomingMessage): boolean {
  const method = String(req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  const readings = requestPathReadings(req)
  const route = READER_ROUTES.find((r) => readings.every((p) => p === r.path))
  if (!route) return false
  const parsed = parsedQuery(req.url ?? '/')
  if (!parsed || !route.shape(parsed, req)) return false
  const routed = routedQuery(req)
  if (routed === null) return false
  return routed === undefined || route.shape(routed, req)
}

/** The routes on the list as the role rules file them (`GET /path`). */
export const READER_ROUTE_KEYS: readonly string[] = READER_ROUTES.map((r) => `GET ${r.path}`)
