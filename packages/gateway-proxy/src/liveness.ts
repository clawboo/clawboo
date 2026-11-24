import type { IncomingMessage } from 'node:http'

import { requestPathReadings } from './request-path'

// ─── The liveness probe ────────────────────────────────────────────────────
//
// One route that answers whether the server is up, with no sign-in: a program
// running beside the server can ask it without the access token or a signed
// identity token. It says up or down and nothing else, so it needs neither.
// The access gate exempts it here, and the server's identity lane by the same
// test, so the two never disagree about what the probe is.

/** The liveness route's path. */
export const LIVENESS_PATH = '/api/system/live'

/** The raw query of a request target, without the `?`: '' when there is none. */
function rawQuery(url: string | undefined): string {
  const raw = url ?? '/'
  const start = raw.indexOf('?')
  if (start === -1) return ''
  const end = raw.indexOf('#', start)
  return raw.slice(start + 1, end === -1 ? undefined : end)
}

/**
 * True when the request is the liveness probe: a GET or a HEAD whose every
 * reading of the path (see request-path.ts) is exactly `/api/system/live`, in
 * lower case, with no query. Anything else, a trailing slash, another letter
 * case or a query included, is an ordinary request.
 */
export function isLivenessRequest(req: IncomingMessage): boolean {
  const method = String(req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  if (rawQuery(req.url) !== '') return false
  return requestPathReadings(req).every((p) => p === LIVENESS_PATH)
}
