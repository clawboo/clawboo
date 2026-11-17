// GET /api/system/live in the server's own order (the access gate, then the API
// router): open with no cookie, a rate-limit bucket of its own ahead of the
// general one, and nothing about the install on the answer, its headers
// included.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { createAccessGate } from '@clawboo/gateway-proxy'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { apiRouter } from '../index'

let server: http.Server
let base = ''

beforeAll(async () => {
  const gate = createAccessGate({ token: 'live-test-token' })
  const app = express()
  app.set('case sensitive routing', true)
  app.use((req, res, next) => {
    if (gate.handleHttp(req, res)) return
    next()
  })
  app.use(apiRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('GET /api/system/live', () => {
  it('answers with no cookie, says nothing else, and has a rate-limit bucket of its own', async () => {
    const res = await fetch(`${base}/api/system/live`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('cache-control')).toBe('no-store')
    // No count of a shared bucket, and not even the framework's name.
    for (const name of [
      'ratelimit',
      'ratelimit-policy',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'x-ratelimit-remaining',
      'x-powered-by',
    ]) {
      expect(res.headers.get(name), name).toBeNull()
    }
    // Its own ceiling: 600 a minute per address, this request counted.
    let answered = 1
    let refused = 0
    for (let i = 0; i < 650 && refused === 0; i += 1) {
      const status = (await fetch(`${base}/api/system/live`, { method: 'HEAD' })).status
      if (status === 200) answered += 1
      else if (status === 429) refused += 1
    }
    expect(answered).toBe(600)
    expect(refused).toBe(1)
    // A signed-in request on the general ceiling is untouched by them all.
    const signedIn = await fetch(`${base}/api/system/capabilities`, {
      headers: { cookie: 'clawboo_access=live-test-token' },
    })
    expect(signedIn.status).toBe(200)
    expect(Number(signedIn.headers.get('ratelimit-remaining'))).toBe(2999)
  })
})
