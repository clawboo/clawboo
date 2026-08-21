import fs from 'node:fs'
import path from 'node:path'

import express, { type Express, type Response } from 'express'

/** Escape a value for use inside a double-quoted HTML attribute. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Resolve a path to its canonical on-disk identity, or null when it is not a
 * readable file. `realpathSync.native` delegates to the OS, so it answers with
 * the filesystem's own idea of identity: real casing on case-insensitive volumes
 * (macOS APFS, Windows NTFS), symlinks followed, and Windows' trailing-dot and
 * trailing-space trimming already applied.
 */
function canonicalFile(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    return null
  }
}

/**
 * Would `express.static` resolve this request path to the shell?
 *
 * This has to be answered the way `send` answers it, and `send` does not compare
 * strings at all: it percent-decodes, normalizes, and then STATS the file. So a
 * string comparison is always a guess at what the filesystem will do, and it
 * loses on any volume where more than one spelling names one file. On the two
 * platforms `npx clawboo` mostly runs on, that is the default: `INDEX.HTML`
 * opens `index.html` on macOS and Windows. Enumerating spellings cannot win, so
 * this asks the filesystem instead and compares canonical paths.
 *
 * Getting it wrong serves the UNTEMPLATED shell, which boots an app with no
 * mount point that addresses the origin root for every request. On the shared
 * hostname this feature exists for, that hands clawboo's traffic, including the
 * provider-key writes, to a neighbouring app.
 */
function isShellPath(rawPath: string, root: string, shellFile: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    // Malformed encoding: `send` rejects it, so it is not the shell.
    return false
  }
  // Normalizing first keeps `..` from ever reaching outside `root`.
  const normalized = path.posix.normalize(decoded)
  // The directory index, which `send` resolves without touching a filename.
  if (normalized === '/') return true
  // Resolve the REQUEST first: a deep SPA route resolves to nothing, so the
  // common case costs one syscall and never touches the shell.
  const candidate = canonicalFile(path.join(root, normalized))
  if (candidate === null) return false
  // Both sides are resolved fresh, per request, and neither answer is cached.
  // Caching either one latches: a null latch makes every spelling look like "not
  // the shell", and a SUCCESS latch keeps the identity the shell had at first
  // request, so a symlink-swap deploy or a replaced build leaves the cached
  // identity pointing at a file the request no longer names. Both mistakes end
  // the same way, with `express.static` serving the raw file.
  return candidate === canonicalFile(shellFile)
}

/**
 * Inject the mount point into the shell's `<head>`.
 *
 * The bundle is built with a RELATIVE Vite base, so `index.html` asks for
 * `./assets/…` and the browser resolves that against the page URL. A deep route
 * like `/clawboo/board` would resolve it to `/clawboo/board/assets/…`, so the
 * `<base href>` pins resolution to the mount regardless of the current route.
 *
 * Injected even at the root (`href="/"`), on purpose: the catch-all serves this
 * same shell for manufactured deep paths, so an uninjected relative-base document
 * would white-screen there. One code path, and the root's behavior is unchanged.
 *
 * `window.__CLAWBOO_BASE__` is the same answer for JS, read by
 * `src/app/bootstrapBase.ts` (API + SSE URLs) and by the gateway client (the
 * WebSocket URL). Assets use `<base>`, code uses the global.
 */
function injectBase(html: string, basePath: string): string {
  const href = `${basePath}/`
  const tags =
    `<base href="${attr(href)}" />` +
    `<script>window.__CLAWBOO_BASE__=${JSON.stringify(basePath)}</script>`
  // After the opening <head> so the base applies to every URL that follows it
  // (a <base> only governs elements AFTER it in document order).
  const headIdx = html.search(/<head[^>]*>/i)
  if (headIdx === -1) return tags + html
  const insertAt = html.indexOf('>', headIdx) + 1
  return html.slice(0, insertAt) + tags + html.slice(insertAt)
}

/**
 * Serve the Vite build output as a static SPA: real files first, then an
 * index.html fallback so client-side routes survive a deep link or a refresh.
 *
 * Extracted from the server boot purely so it can be tested — the dot-directory
 * case below is impossible to reproduce from a normal repo checkout.
 *
 * `basePath` is the already-normalized URL prefix the app is mounted under ('' at
 * the root). Requests arrive here with the prefix ALREADY STRIPPED (see
 * `basePathMiddleware`), so it is used only to template the shell, never to match.
 */
export function mountSpa(app: Express, uiDir: string, basePath = ''): void {
  const root = path.resolve(uiDir)

  /**
   * Send the templated shell with the caching headers `express.static` used to
   * put on it. Serving from memory would otherwise silently drop them, and
   * `Cache-Control: public, max-age=0` plus `Last-Modified` are what let a
   * browser revalidate into a 304 instead of re-downloading the document on
   * every navigation. `Accept-Ranges` is deliberately NOT restored: `send`
   * advertised range support because it streamed a file, and this response
   * cannot serve one. Express adds the ETag itself.
   */
  const sendShell = (res: Response, html: string): void => {
    res.type('html')
    res.setHeader('Cache-Control', 'public, max-age=0')
    const mtime = shellMtime()
    if (mtime) res.setHeader('Last-Modified', mtime)
    // `send` omits the body for HEAD on its own.
    res.send(html)
  }

  const shellFile = path.join(root, 'index.html')

  /** The shell's on-disk mtime as an HTTP date, or null when it cannot be read. */
  const shellMtime = (): string | null => {
    try {
      return fs.statSync(shellFile).mtime.toUTCString()
    } catch {
      return null
    }
  }

  // Read + template on demand, then serve from memory. The shell is a few KB and
  // the injection is a pure function of (file, basePath), so re-reading per
  // request would buy nothing. Failure is NOT latched: the ui dir can be
  // unreadable for a moment (a slow network or container mount, a Windows
  // indexer's handle, EMFILE), and one bad read must not outlive it.
  let cached: string | null = null

  const shell = (): string | null => {
    if (cached !== null) return cached
    try {
      cached = injectBase(fs.readFileSync(shellFile, 'utf8'), basePath)
      return cached
    } catch {
      return null
    }
  }

  /**
   * The invariant: a request for the shell is answered with the TEMPLATED shell
   * or with an error. Never with the file on disk.
   *
   * An untemplated shell carries no mount point, so the SPA it boots addresses
   * the origin root for every request, and on the shared hostname this feature
   * exists for that hands clawboo's traffic to a neighbouring app. It is also
   * broken on its own terms: the build uses a relative base, so without the
   * injected `<base href>` a deep route resolves `./assets/…` against the route
   * and white-screens.
   *
   * So there is no fall-through here. Calling `next()` on a shell-shaped path
   * would hand it to `express.static` (or, in the catch-all, to `sendFile`),
   * either of which answers 200 with the raw document. A read failure is a
   * genuine 503: the server knows what was wanted and cannot produce it, and
   * saying so is both honest and safe, where guessing is neither.
   */
  const serveShellOr503 = (res: Response): void => {
    const html = shell()
    if (html !== null) {
      sendShell(res, html)
      return
    }
    res
      .status(503)
      .type('text')
      .send('The Clawboo dashboard could not be read from disk. Check CLAWBOO_UI_DIR.')
  }

  // Intercept the shell BEFORE the static handler, which would otherwise answer
  // with the raw file. (`index: false` below only suppresses the DIRECTORY
  // index, not an explicit `/index.html`.)
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (!isShellPath(req.path, root, shellFile)) return next()
    serveShellOr503(res)
  })

  app.use(express.static(root, { index: false }))

  // SPA catch-all: any unmatched GET serves index.html so client-side routing
  // works. We use `app.use(handler)` rather than a wildcard pattern
  // (`'/*splat'` / `'/{*splat}'`) — Express 5 + path-to-regexp v8 have subtle
  // matching quirks around the bare `/` path that produced "Cannot GET /".
  // `app.use` with no path matches every request by definition. Restricting to
  // GET and HEAD keeps other methods 404ing honestly, while keeping HEAD and GET
  // in agreement on every URL (a HEAD that 404s where GET returns 200 breaks
  // uptime probes and violates RFC 9110).
  //
  // Historical note: this used to end in `res.sendFile('index.html', { root })`,
  // and the `{ root }` form was load-bearing, because `send` explodes a bare
  // absolute path into segments and 404s any that starts with a dot, which is
  // where `npx clawboo` installs (`~/.npm/_npx/…`). Serving from memory retires
  // that hazard: `readFileSync` does not care about dot-directories.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    serveShellOr503(res)
  })
}
