// Serve the whole app under a URL path prefix (CLAWBOO_BASE_PATH) by STRIPPING the
// prefix at the very front of the middleware stack, so nothing behind it ever sees
// a prefixed path.
//
// This is the security-load-bearing choice. The origin guard and the access gate
// both decide whether to protect a request by testing `pathname.startsWith('/api/')`,
// and those tests FAIL OPEN: a path they do not recognize is treated as a static
// asset and waved through. Mounting the API at `${base}/api` while leaving those
// tests matching `/api/` would therefore leave every prefixed API route
// unauthenticated and unguarded. Stripping first means the guards keep their
// existing, tested checks and cover both surfaces with no change at all.
//
// It also keeps the ROOT `/api/*` surface served unstripped, because the loopback
// control plane talks to it directly and knows nothing about the prefix: the CLI's
// discovery probe, the MCP attach URLs handed to spawned runtimes, and the
// self-update check. That surface stays exactly as gated as it is today
// (origin guard + access gate + the loopback-only MCP exemption).
//
// Ordering rule: this must be installed BEFORE the origin guard, and no route may
// be mounted ahead of it. A route registered earlier would see prefixed paths and
// would be judged by guards that never ran.

import type { NextFunction, Request, RequestHandler, Response } from 'express'

/** Path portion of a raw request URL (no query, never empty). */
function pathnameOf(url: string | undefined): string {
  const raw = typeof url === 'string' ? url : ''
  const idx = raw.indexOf('?')
  return (idx === -1 ? raw : raw.slice(0, idx)) || '/'
}

/** Query portion including the leading '?', or '' when there is none. */
function searchOf(url: string | undefined): string {
  const raw = typeof url === 'string' ? url : ''
  const idx = raw.indexOf('?')
  return idx === -1 ? '' : raw.slice(idx)
}

/**
 * Build the prefix-strip middleware. `basePath` must already be normalized by
 * `normalizeBasePath` ('' or a leading-slash, no-trailing-slash prefix).
 *
 * With `basePath === ''` this returns a pass-through, so an install that never
 * sets the variable behaves exactly as it did before this existed.
 */
export function createBasePathMiddleware(basePath: string): RequestHandler {
  if (!basePath) return (_req, _res, next) => next()

  const prefix = `${basePath}/`

  return (req: Request, res: Response, next: NextFunction): void => {
    const pathname = pathnameOf(req.url)

    // Under the prefix: strip it so everything downstream sees a root-form path.
    // `originalUrl` keeps the prefix, so logs and redirects can still show it.
    if (pathname === prefix || pathname.startsWith(prefix)) {
      req.url = req.url.slice(basePath.length) || '/'
      next()
      return
    }

    // Bare prefix with no trailing slash: send the browser to the canonical form.
    // The shell's injected `<base href>` ends in a slash, so relative asset URLs
    // only resolve correctly once the page URL does too. Query is preserved.
    if (pathname === basePath) {
      res.redirect(302, `${prefix}${searchOf(req.url)}`)
      return
    }

    // The loopback control plane addresses the API at the root, unprefixed, and
    // must keep working: the CLI probe, the MCP attach URLs, the self-update
    // check. Passed through UNSTRIPPED and therefore judged by exactly the same
    // origin guard and access gate as before.
    if (pathname.toLowerCase().startsWith('/api/')) {
      next()
      return
    }

    // The root itself: point a browser that landed on '/' at the real mount, so a
    // bookmark or a proxy misconfiguration is a redirect rather than a blank page.
    // Query is preserved, which is what keeps the CLI's printed
    // `/?access_token=...` link working.
    if (pathname === '/') {
      res.redirect(302, `${prefix}${searchOf(req.url)}`)
      return
    }

    // Everything else is outside the mount. 404 rather than fall through, so the
    // SPA exists at exactly one place and a stray path cannot reach the catch-all.
    res.status(404).json({ error: `Not found. This Clawboo is served under ${prefix}` })
  }
}
