// The URL path prefix clawboo is served under (CLAWBOO_BASE_PATH), normalized once
// and shared by everything that has to agree on it: the Express mount, the SPA
// shell the server templates, the WebSocket upgrade route, the access cookie's
// scope, and the URLs the CLI prints.
//
// Lives here rather than in the server because the CLI needs the same answer
// without importing the server, and @clawboo/config is the package both already
// depend on. It is pure string work: no filesystem, no env beyond the one read.
//
// The stored form is either '' (serve at the origin root, the default and the
// behavior of every install that never sets the variable) or '/segment' with no
// trailing slash, so callers can always write `${basePath}/api/...` and get a
// single leading slash.

/** A rejected value, with the reason to show the operator before exiting. */
export interface BasePathError {
  ok: false
  reason: string
}

export interface BasePathOk {
  ok: true
  /** '' for the root, else a leading-slash, no-trailing-slash prefix. */
  basePath: string
}

export type BasePathResult = BasePathOk | BasePathError

// Per segment: unreserved URL characters only. Anything needing percent-encoding
// would have to be encoded identically by the server, the SPA, and the proxy, and
// a mismatch there is a silently broken mount rather than a loud error.
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/

/**
 * Normalize a raw CLAWBOO_BASE_PATH value.
 *
 * Accepts a missing leading slash and a trailing slash (`clawboo`, `/clawboo/`
 * and `/clawboo` all normalize to `/clawboo`), since an operator copying a proxy
 * location block will write it either way. Empty and `/` mean the root.
 *
 * Rejects rather than silently repairing anything that would change what the
 * prefix MATCHES: empty segments, dot segments, percent signs, whitespace,
 * backslashes, query or fragment characters. Also rejects a first segment of
 * `api`, which would collide with the API surface the mount serves underneath.
 */
export function normalizeBasePath(raw: string | undefined | null): BasePathResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed === '/') return { ok: true, basePath: '' }

  if (/\s/.test(trimmed)) return { ok: false, reason: 'contains whitespace' }
  if (trimmed.includes('\\')) return { ok: false, reason: 'contains a backslash' }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, reason: 'contains a query or fragment character' }
  }
  if (trimmed.includes('%')) {
    return { ok: false, reason: 'contains a percent sign (use unencoded characters)' }
  }

  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const withoutTrailing = withLeading.replace(/\/+$/, '')
  // A value that was only slashes ('//' or '///') collapses to empty here, which
  // is an empty segment rather than the root.
  if (!withoutTrailing) return { ok: false, reason: 'contains only slashes' }

  const segments = withoutTrailing.slice(1).split('/')
  for (const segment of segments) {
    if (!segment) return { ok: false, reason: 'contains an empty segment (a doubled slash)' }
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: `contains a '${segment}' segment` }
    }
    if (!SEGMENT_RE.test(segment)) {
      return {
        ok: false,
        reason: `segment '${segment}' has characters outside A-Z a-z 0-9 . _ ~ -`,
      }
    }
  }
  if (segments[0]?.toLowerCase() === 'api') {
    return { ok: false, reason: "must not start with 'api' (it would collide with the API routes)" }
  }

  return { ok: true, basePath: withoutTrailing }
}

/** Read + normalize CLAWBOO_BASE_PATH from an env bag. */
export function resolveBasePath(env: NodeJS.ProcessEnv = process.env): BasePathResult {
  return normalizeBasePath(env['CLAWBOO_BASE_PATH'])
}

/**
 * The base path, or '' when unset or invalid. For callers that only DISPLAY a URL
 * (the CLI's printed links) and must not fail on a value the server will reject
 * on its own with a precise message.
 */
export function resolveBasePathOrRoot(env: NodeJS.ProcessEnv = process.env): string {
  const result = resolveBasePath(env)
  return result.ok ? result.basePath : ''
}
