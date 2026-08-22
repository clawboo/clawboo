// SPA-serving guard. The catch-all that makes deep links and refreshes work has
// broken twice for shipped users, both times invisibly to CI:
//   v0.1.1, an Express 5 wildcard-pattern quirk produced "Cannot GET /".
//   this one, `res.sendFile(absolutePath)` without a `root`, where `send`
//   explodes the WHOLE absolute path and 404s any segment starting with a dot.
// The second only reproduces when the install path contains a dot-directory,
// which is exactly where `npx clawboo` lands (`~/.npm/_npx/…`) and never where
// CI checks out. So this test builds both layouts explicitly.
//
// `sendFile` is gone entirely now: the shell is read with `readFileSync` and
// served from memory so the mount point can be templated into it, and
// `readFileSync` is indifferent to dot-directories. That RETIRES the hazard
// rather than guarding it, and the dot-directory matrix now proves the weaker
// but still worthwhile claim that an npx-shaped install path serves end to end.
//
// The invariant those cases defend is stated in serveSpa.ts: a request for the
// shell is answered with the TEMPLATED shell or with an error, never with the
// file on disk. An untemplated shell carries no mount point, so the SPA it boots
// addresses the origin root for the whole session.

import fs, { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { mountSpa } from '../serveSpa'

// Mirrors the real shell closely enough to exercise the head injection: a <head>
// to inject after, and a RELATIVE asset ref (the build uses a relative Vite base,
// which is what makes the injected <base href> load-bearing).
const INDEX_HTML =
  '<!doctype html><html><head><meta charset="UTF-8" /></head>' +
  '<body><div id="root"></div><script type="module" src="./assets/index.js"></script></body></html>'

/** Build a ui dir at `<tmp>/<segment>/ui` holding an index.html + one real asset. */
function makeUiDir(segment: string): string {
  const base = mkdtempSync(path.join(os.tmpdir(), 'clawboo-spa-'))
  const uiDir = path.join(base, segment, 'ui')
  mkdirSync(uiDir, { recursive: true })
  writeFileSync(path.join(uiDir, 'index.html'), INDEX_HTML)
  writeFileSync(path.join(uiDir, 'app.js'), 'export const x = 1\n')
  return uiDir
}

const servers: http.Server[] = []

function serve(uiDir: string, basePath = ''): Promise<string> {
  const app = express()
  mountSpa(app, uiDir, basePath)
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server)
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

afterAll(() => {
  for (const server of servers) server.close()
})

describe.each([
  ['a normal install path', 'plain'],
  // The npx case: `~/.npm/_npx/<hash>/node_modules/clawboo/dist/ui`.
  ['an install path containing a dot-directory', '.npm'],
])('SPA serving under %s', (_label, segment) => {
  it('serves index.html at the root', async () => {
    const base = await serve(makeUiDir(segment))
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  it('falls a deep client-side route through to index.html', async () => {
    const base = await serve(makeUiDir(segment))
    for (const route of ['/board', '/some/spa/route', '/teams/abc/agents/def']) {
      const res = await fetch(`${base}${route}`)
      expect(res.status, `${route} should serve the SPA shell`).toBe(200)
      expect(await res.text()).toContain('<div id="root">')
    }
  })

  it('still serves real static assets rather than the shell', async () => {
    const base = await serve(makeUiDir(segment))
    const res = await fetch(`${base}/app.js`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('export const x = 1')
  })

  it('leaves non-GET requests to 404 honestly', async () => {
    const base = await serve(makeUiDir(segment))
    const res = await fetch(`${base}/api/nope`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('injects the mount point into the shell it serves', async () => {
    // The build uses a RELATIVE Vite base, so `./assets/...` resolves against the
    // page URL. Without an injected <base href>, a deep route would resolve it to
    // `/some/spa/route/assets/...` and white-screen. Injected at the root too, so
    // there is one code path and the deep-route case is covered there as well.
    const base = await serve(makeUiDir(segment))
    for (const route of ['/', '/some/spa/route']) {
      const html = await (await fetch(`${base}${route}`)).text()
      expect(html).toContain('<base href="/" />')
      expect(html).toContain('window.__CLAWBOO_BASE__=""')
      // Injected INSIDE head and after its opening tag: a <base> only governs
      // elements that follow it.
      expect(html.indexOf('<base')).toBeGreaterThan(html.indexOf('<head>'))
      expect(html.indexOf('<base')).toBeLessThan(html.indexOf('./assets/index.js'))
    }
  })

  it('injects the configured prefix when mounted under one', async () => {
    // Requests reach mountSpa with the prefix already stripped, so the paths here
    // are root-form; the prefix only shapes what gets templated into the shell.
    const base = await serve(makeUiDir(segment), '/clawboo')
    for (const route of ['/', '/board']) {
      const html = await (await fetch(`${base}${route}`)).text()
      expect(html).toContain('<base href="/clawboo/" />')
      expect(html).toContain('window.__CLAWBOO_BASE__="/clawboo"')
    }
    // Real assets are still served raw, never templated.
    const asset = await fetch(`${base}/app.js`)
    expect(await asset.text()).toContain('export const x = 1')
  })

  it('serves the templated shell for /index.html too, not the raw file', async () => {
    // `express.static` runs first and would otherwise hand back an un-injected
    // document for this one path.
    const base = await serve(makeUiDir(segment), '/clawboo')
    const html = await (await fetch(`${base}/index.html`)).text()
    expect(html).toContain('window.__CLAWBOO_BASE__="/clawboo"')
  })

  it('SECURITY: no spelling of the shell path can return the UNTEMPLATED file', async () => {
    // `send` percent-decodes and normalizes before reading from disk, so these
    // all resolve to index.html. Matching only the raw spelling let them reach
    // the static handler, which answered with the un-injected document: the SPA
    // then booted with no mount point and addressed every API call at the origin
    // root, which on a shared origin means handing clawboo's requests (provider
    // key writes among them) to a neighbouring app.
    const base = await serve(makeUiDir(segment), '/clawboo')
    for (const spelling of [
      '//index.html',
      '/index.htm%6C',
      '/%69ndex.html',
      // Case variants: on macOS and Windows (the platforms `npx clawboo` mostly
      // runs on) the filesystem itself resolves these to the same file, so a
      // string comparison against '/index.html' waves them through to the static
      // handler. On a case-SENSITIVE volume they are simply 404s that fall to the
      // catch-all, which serves the templated shell, so the assertion holds
      // either way.
      '/INDEX.HTML',
      '/Index.html',
      '/index.HTML',
      '//INDEX.HTML',
      // Dot segments are removed by the WHATWG URL parser before the request is
      // sent, so these two arrive as plain '/index.html'. Kept as documentation
      // that the client-side normalization is what makes them safe.
      '/./index.html',
      '/sub/../index.html',
      // Not a dot segment: '//' survives the URL parser intact and reaches the
      // server, where it is the directory-index spelling of the mount root.
      '//',
    ]) {
      const res = await fetch(`${base}${spelling}`)
      const html = await res.text()
      expect(html, `${spelling} must not serve the raw shell`).toContain(
        'window.__CLAWBOO_BASE__="/clawboo"',
      )
    }
  })

  it('keeps the caching headers the static handler used to send', async () => {
    // Serving from memory silently dropped these. Without them a browser
    // re-downloads the shell on every navigation instead of revalidating into a
    // 304. `Accept-Ranges` is deliberately not restored: it advertised range
    // support that a string response cannot honor.
    const base = await serve(makeUiDir(segment), '/clawboo')
    for (const p of ['/', '/index.html', '/board']) {
      const res = await fetch(`${base}${p}`)
      expect(res.headers.get('cache-control'), p).toBe('public, max-age=0')
      expect(res.headers.get('last-modified'), p).toBeTruthy()
      expect(res.headers.get('etag'), p).toBeTruthy()
    }
  })

  it('answers HEAD wherever it answers GET', async () => {
    // `index: false` removed the handler that used to answer a bare `HEAD /`,
    // so it fell through to a 404 while GET stayed 200. Uptime probes use HEAD,
    // and disagreeing with GET on the same URL violates RFC 9110.
    const base = await serve(makeUiDir(segment), '/clawboo')
    for (const p of ['/', '/index.html', '/board']) {
      const head = await fetch(`${base}${p}`, { method: 'HEAD' })
      const get = await fetch(`${base}${p}`)
      expect(head.status, `HEAD ${p}`).toBe(get.status)
      expect(head.status).toBe(200)
    }
  })
})

describe('SPA serving when the shell cannot be read', () => {
  it('503s rather than crashing when the ui dir has no index.html', async () => {
    // Per request, never a boot-time throw. 503 rather than 404 because the
    // server knows exactly what was asked for and cannot produce it, and because
    // the alternative was falling through to a handler that answers 200 with the
    // raw file (see the SECURITY case below).
    const empty = mkdtempSync(path.join(os.tmpdir(), 'clawboo-spa-empty-'))
    const base = await serve(empty)
    for (const p of ['/', '/board', '/index.html']) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(503)
    }
  })

  it('SECURITY: an unreadable shell is an error, never the raw file', async () => {
    // The invariant, stated as a test: a request for the shell is answered with
    // the TEMPLATED shell or with an error. A transient read failure used to
    // `next()` into express.static (for /index.html) or `sendFile` (for a deep
    // route), each of which answers 200 with the untemplated document, which
    // strips the mount point and points the whole session at the origin root.
    const uiDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-spa-unread-'))
    writeFileSync(path.join(uiDir, 'index.html'), INDEX_HTML)
    const base = await serve(uiDir, '/clawboo')

    // Make the file unreadable the way a lock or an fd exhaustion would, while
    // leaving it perfectly servable by `send`.
    const realRead = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: never[]) => {
      if (typeof p === 'string' && p.endsWith('index.html')) {
        throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
      }
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readFileSync)
    try {
      for (const p of ['/', '/index.html', '/INDEX.HTML', '/board']) {
        const res = await fetch(`${base}${p}`)
        const body = await res.text()
        expect(res.status, `${p} must not answer 200 with the raw shell`).toBe(503)
        expect(body).not.toContain('<div id="root">')
      }
    } finally {
      spy.mockRestore()
    }

    // And it recovers on the next request once the read succeeds again.
    const html = await (await fetch(`${base}/index.html`)).text()
    expect(html).toContain('window.__CLAWBOO_BASE__="/clawboo"')
  })

  it('SECURITY: recovers the shell identity when the ui dir appears after mount', async () => {
    // The ui dir can be unreadable for a moment at boot (a slow network or
    // container mount, an indexer's handle, EMFILE). Resolving the shell's
    // identity ONCE would leave it null forever, and a null identity makes every
    // spelling look like "not the shell", so express.static answers with the RAW
    // untemplated file: a latch here fails OPEN, permanently, on exactly the
    // deployment this feature exists for.
    const late = mkdtempSync(path.join(os.tmpdir(), 'clawboo-spa-late-'))
    const uiDir = path.join(late, 'ui')
    const base = await serve(uiDir, '/clawboo')

    // Nothing on disk yet: an honest error, and no raw file to leak.
    expect((await fetch(`${base}/index.html`)).status).toBe(503)

    mkdirSync(uiDir, { recursive: true })
    writeFileSync(path.join(uiDir, 'index.html'), INDEX_HTML)

    for (const p of ['/', '/index.html', '/INDEX.HTML', '/board']) {
      const html = await (await fetch(`${base}${p}`)).text()
      expect(html, `${p} after the ui dir appeared`).toContain('window.__CLAWBOO_BASE__="/clawboo"')
    }
  })
})
