// SPA-serving guard. The catch-all that makes deep links and refreshes work has
// broken twice for shipped users, both times invisibly to CI:
//   v0.1.1, an Express 5 wildcard-pattern quirk produced "Cannot GET /".
//   this one, `res.sendFile(absolutePath)` without a `root`, where `send`
//   explodes the WHOLE absolute path and 404s any segment starting with a dot.
// The second only reproduces when the install path contains a dot-directory,
// which is exactly where `npx clawboo` lands (`~/.npm/_npx/…`) and never where
// CI checks out. So this test builds both layouts explicitly.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, describe, expect, it } from 'vitest'

import { mountSpa } from '../serveSpa'

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'

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

function serve(uiDir: string): Promise<string> {
  const app = express()
  mountSpa(app, uiDir)
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
})
