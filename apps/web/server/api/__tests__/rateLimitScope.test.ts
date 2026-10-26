// The general rate ceiling counts /api traffic only. The API router is mounted
// at the app root ahead of the SPA, so a limiter attached with a bare
// `router.use` would also count every script chunk, font and shell request
// passing through on its way to `mountSpa`, which has its own static ceiling.
// A cold page load is ~15 API calls but ~90 static requests, so that double
// count lets a burst of page loads (the e2e suite makes ~25 a minute) spend the
// API budget while API traffic itself is far below the limit.
//
// Built from the real router and the real SPA mount, in the server's order.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Sandbox every state path before the router's module graph loads, so nothing it
// touches can reach a developer's real ~/.clawboo or ~/.openclaw.
await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const nodeOs = await import('node:os')
  const nodePath = await import('node:path')
  const home = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'clawboo-ratelimit-'))
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = nodePath.join(home, '.clawboo')
  process.env['OPENCLAW_STATE_DIR'] = nodePath.join(home, '.openclaw')
})

// /api/health is the probe route: answered from memory, with no side effects.
vi.mock('../../lib/bootProbe', () => ({
  getLastBootReport: () => ({
    generatedAt: 0,
    checks: [],
    degraded: [],
    fatal: [],
    config: {},
    resolved: { apiPort: 0, clawbooHome: '', dbPath: '' },
  }),
  runBootProbe: vi.fn(),
}))

import { mountSpa } from '../../lib/serveSpa'
import { apiRouter } from '../index'

let base = ''
let server: http.Server | null = null

beforeAll(async () => {
  const uiDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-ratelimit-ui-'))
  mkdirSync(path.join(uiDir, 'assets'))
  writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><head></head></html>')
  writeFileSync(path.join(uiDir, 'assets', 'chunk.js'), 'export {}\n')

  const app = express()
  app.use(apiRouter)
  mountSpa(app, uiDir)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server?.address()
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

/** The general limiter's remaining budget, read off an API response. */
async function apiRemaining(): Promise<number> {
  const res = await fetch(`${base}/api/health`)
  expect(res.status).toBe(200)
  const remaining = res.headers.get('ratelimit-remaining')
  expect(remaining).not.toBeNull()
  return Number(remaining)
}

describe('general rate limiter scope', () => {
  it('does not spend the API budget on static assets or the shell', async () => {
    const before = await apiRemaining()
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${base}/assets/chunk.js`)).status).toBe(200)
    }
    expect((await fetch(`${base}/`)).status).toBe(200)
    expect((await fetch(`${base}/some/deep/route`)).status).toBe(200)
    // Only the probe itself was counted.
    expect(await apiRemaining()).toBe(before - 1)
  })

  it('still counts every API request', async () => {
    const before = await apiRemaining()
    await apiRemaining()
    await apiRemaining()
    expect(await apiRemaining()).toBe(before - 3)
  })

  it('leaves static requests under their own ceiling', async () => {
    const res = await fetch(`${base}/assets/chunk.js`)
    expect(res.headers.get('ratelimit-policy')).toBe('3000;w=60')
    const first = Number(res.headers.get('ratelimit-remaining'))
    await apiRemaining()
    const next = await fetch(`${base}/assets/chunk.js`)
    // The API call in between does not touch the static budget either.
    expect(Number(next.headers.get('ratelimit-remaining'))).toBe(first - 1)
  })
})
