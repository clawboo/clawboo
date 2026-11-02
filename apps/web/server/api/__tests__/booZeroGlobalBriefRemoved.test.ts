// Boo Zero's Global Brief was saved but never read into any prompt, while its
// editor said it was injected on every interaction. The field and its two
// routes were removed; the per-team brief and the display-name override stay.

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
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-global-brief-'))
  process.env['CLAWBOO_HOME'] = dir
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

it('no longer serves the global brief', async () => {
  expect((await fetch(`${base}/api/boo-zero/global-brief`)).status).toBe(404)
  const put = await fetch(`${base}/api/boo-zero/global-brief`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'never read' }),
  })
  expect(put.status).toBe(404)
})

it('still serves the display-name override', async () => {
  const res = await fetch(`${base}/api/boo-zero/display-name/some-agent`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: null })
})
