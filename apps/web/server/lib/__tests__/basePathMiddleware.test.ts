// The prefix-strip middleware, and the security property it exists to provide.
//
// The origin guard and the access gate decide whether to protect a request by
// testing `pathname.startsWith('/api/')`, and those tests fail OPEN. So the thing
// that actually has to hold is not "the prefix is stripped" but "nothing behind
// this middleware ever observes a prefixed path". The last test asserts exactly
// that against a recorder standing where the guards stand.

import express from 'express'
import type { Server } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'

import { createBasePathMiddleware } from '../basePathMiddleware'

const servers: Server[] = []
afterAll(() => {
  for (const s of servers) s.close()
})

/** Boot an app on an ephemeral port and return its origin. */
function serve(build: (app: express.Express) => void): Promise<string> {
  const app = express()
  build(app)
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server)
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

/** An app mounted under `/clawboo` that echoes the path each layer observed. */
function mountedApp(basePath: string) {
  return (app: express.Express) => {
    app.use(createBasePathMiddleware(basePath))
    app.get('/api/settings', (req, res) => {
      res.json({ seenUrl: req.url, originalUrl: req.originalUrl })
    })
    // Stands in for the SPA catch-all.
    app.use((req, res) => {
      res.status(200).json({ shell: true, seenUrl: req.url, originalUrl: req.originalUrl })
    })
  }
}

describe('createBasePathMiddleware', () => {
  it('is a pass-through when no base path is configured', async () => {
    const origin = await serve(mountedApp(''))
    const res = await fetch(`${origin}/api/settings`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ seenUrl: '/api/settings' })
    // A deep route still reaches the shell exactly as before.
    const deep = await fetch(`${origin}/some/deep/route`)
    expect(deep.status).toBe(200)
    expect(await deep.json()).toMatchObject({ shell: true })
  })

  it('strips the prefix for routes underneath it, keeping originalUrl intact', async () => {
    const origin = await serve(mountedApp('/clawboo'))
    const res = await fetch(`${origin}/clawboo/api/settings`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      seenUrl: '/api/settings',
      originalUrl: '/clawboo/api/settings',
    })
  })

  it('serves the shell for the mount root and for deep routes under it', async () => {
    const origin = await serve(mountedApp('/clawboo'))
    for (const path of ['/clawboo/', '/clawboo/board', '/clawboo/agents/x/y']) {
      const res = await fetch(`${origin}${path}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ shell: true })
    }
  })

  it('redirects the bare prefix and the root to the canonical mount, preserving the query', async () => {
    const origin = await serve(mountedApp('/clawboo'))
    // The injected <base href> ends in a slash, so relative assets only resolve
    // once the page URL does too.
    const bare = await fetch(`${origin}/clawboo`, { redirect: 'manual' })
    expect(bare.status).toBe(302)
    expect(bare.headers.get('location')).toBe('/clawboo/')

    // The CLI prints `/?access_token=...`; losing the query would break that link.
    const root = await fetch(`${origin}/?access_token=abc123`, { redirect: 'manual' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/clawboo/?access_token=abc123')
  })

  it('keeps the unprefixed /api surface for the loopback control plane', async () => {
    // The CLI probe, the MCP attach URLs handed to spawned runtimes, the boot
    // probe and the self-update check all address the API at the root and know
    // nothing about the prefix.
    const origin = await serve(mountedApp('/clawboo'))
    const res = await fetch(`${origin}/api/settings`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ seenUrl: '/api/settings' })
  })

  it('404s paths outside the mount instead of falling through to the shell', async () => {
    const origin = await serve(mountedApp('/clawboo'))
    for (const path of ['/clawboonot/x', '/elsewhere', '/assets/index.js']) {
      const res = await fetch(`${origin}${path}`)
      expect(res.status).toBe(404)
    }
  })

  it('does not treat a case-mismatched prefix as the mount', async () => {
    // Route matching is case-sensitive server-wide (`case sensitive routing`), so
    // a prefix test that folded case would disagree with the routes behind it.
    const origin = await serve(mountedApp('/clawboo'))
    const res = await fetch(`${origin}/Clawboo/api/settings`)
    expect(res.status).toBe(404)
  })

  it('SECURITY: nothing behind the middleware ever observes a prefixed path', async () => {
    // The origin guard and access gate gate on `startsWith('/api/')` and fail OPEN
    // for anything else, so a prefixed path reaching them would be an unguarded,
    // unauthenticated API. This is the property that makes stripping safe, so it
    // is asserted directly rather than inferred from the routing tests above.
    const observed: string[] = []
    const origin = await serve((app) => {
      app.use(createBasePathMiddleware('/clawboo'))
      // Stands exactly where the origin guard and access gate are installed.
      app.use((req, _res, next) => {
        observed.push(req.url)
        next()
      })
      app.get('/api/settings', (_req, res) => res.json({ ok: true }))
      app.use((_req, res) => res.status(200).json({ shell: true }))
    })

    for (const path of [
      '/clawboo/',
      '/clawboo/api/settings',
      '/clawboo/api/agents?includeArchived=true',
      '/clawboo/board',
      '/api/settings',
    ]) {
      await fetch(`${origin}${path}`)
    }

    expect(observed.length).toBeGreaterThan(0)
    for (const url of observed) {
      expect(url.startsWith('/clawboo')).toBe(false)
    }
    // And the API paths still arrive in the exact form the guards test for.
    expect(observed).toContain('/api/settings')
    expect(observed).toContain('/api/agents?includeArchived=true')
  })
})
