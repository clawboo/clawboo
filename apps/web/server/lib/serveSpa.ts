import path from 'node:path'

import express, { type Express } from 'express'

/**
 * Serve the Vite build output as a static SPA: real files first, then an
 * index.html fallback so client-side routes survive a deep link or a refresh.
 *
 * Extracted from the server boot purely so it can be tested — the dot-directory
 * case below is impossible to reproduce from a normal repo checkout.
 */
export function mountSpa(app: Express, uiDir: string): void {
  const root = path.resolve(uiDir)
  app.use(express.static(root))

  // SPA catch-all: any unmatched GET serves index.html so client-side routing
  // works. We use `app.use(handler)` rather than a wildcard pattern
  // (`'/*splat'` / `'/{*splat}'`) — Express 5 + path-to-regexp v8 have subtle
  // matching quirks around the bare `/` path that produced "Cannot GET /".
  // `app.use` with no path matches every request by definition. Restricting to
  // GET keeps non-GET 404s honest.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    // `sendFile` MUST take a relative path + `{ root }`, never one absolute
    // path. Without `root`, `send` explodes the WHOLE absolute path into
    // segments and 404s if any segment starts with a dot (its default
    // `dotfiles: 'ignore'`). `npx clawboo` installs under `~/.npm/_npx/…`, so
    // the `.npm` segment made every deep route 404 for real users while `/`
    // still worked — `express.static` above already passes a `root`, so only
    // this fallback was affected. CI never caught it: runners check out to a
    // dot-free path.
    res.sendFile('index.html', { root })
  })
}
