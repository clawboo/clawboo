// The API router must match route casing exactly. `app.set('case sensitive
// routing', true)` never reached it: a Router reads that option only from its own
// constructor, so `/API/settings` used to reach the `/api/settings` handler. The
// access gate lowercases before its own /api/ test, so this was never a bypass,
// but the router and the gate must agree about what a path is.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { resetDb } from '../../lib/db'
import { apiRouter } from '../index'

let dir: string
let prevHome: string | undefined
let server: http.Server
let base: string

beforeAll(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-router-case-'))
  process.env['CLAWBOO_HOME'] = dir
  // Mounted exactly as ../../index.ts mounts it, app-level option included.
  const app = express()
  app.set('case sensitive routing', true)
  app.use(express.json())
  app.use(apiRouter)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  rmSync(dir, { recursive: true, force: true })
})

it('routes the lowercase path', async () => {
  expect((await fetch(`${base}/api/settings`)).status).toBe(200)
})

it('does not route a case variant of it', async () => {
  for (const variant of ['/API/settings', '/Api/Settings', '/api/SETTINGS']) {
    expect((await fetch(`${base}${variant}`)).status, variant).toBe(404)
  }
})
