// The preview route serves agent-written HTML from the dashboard's own origin.
// The drawer's iframe is sandboxed, but the "Open" link loads the same URL top
// level, where only a response header can sandbox it. So every preview
// response, on every subpath, carries the iframe's exact flags as a CSP: no
// script, and same-origin kept so the page's own assets pass the origin guard.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

let root: string

vi.mock('../../lib/workspaceFs', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/workspaceFs')>()
  return {
    ...actual,
    resolveTaskFilesRoot: vi.fn(async () => ({ ok: true as const, root, exactRoot: false })),
  }
})

const { resetDb } = await import('../../lib/db')
const { apiRouter } = await import('../index')

let home: string
let prevHome: string | undefined
let server: http.Server
let base: string

beforeAll(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-preview-csp-'))
  process.env['CLAWBOO_HOME'] = home
  root = await mkdtemp(path.join(os.tmpdir(), 'clawboo-preview-csp-root-'))
  await writeFile(path.join(root, 'index.html'), '<script>fetch("/api/settings")</script>')
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'app.css'), 'h1 { color: red }')
  await writeFile(path.join(root, 'src', 'app.js'), 'console.log(1)')
  const app = express()
  app.set('case sensitive routing', true)
  app.use(apiRouter)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board/t1/preview`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  await rm(home, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

it('sandboxes every preview response without letting script run', async () => {
  const cases: Array<[string, number]> = [
    ['', 302], // the bare route redirects to the trailing-slash index
    ['/', 200],
    ['/index.html', 200],
    ['/src/app.css', 200],
    ['/src/app.js', 200],
    ['/missing.html', 400], // an error reply carries it too
  ]
  for (const [sub, status] of cases) {
    const res = await fetch(`${base}${sub}`, { redirect: 'manual' })
    expect(res.status, sub).toBe(status)
    expect(res.headers.get('content-security-policy'), sub).toBe('sandbox allow-same-origin')
    // The header on a redirect does not travel with it, so the redirect must
    // land on the preview's own index, which is sandboxed above.
    if (status === 302) expect(res.headers.get('location'), sub).toBe('/api/board/t1/preview/')
    await res.arrayBuffer()
  }
})
