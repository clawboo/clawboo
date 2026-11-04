// POST /api/access/launch-code, wired the way ../../index.ts wires it: the real
// access gate in front, the real API router behind it, and the gate published on
// app.locals for the route to mint from. A code it hands out trades for the
// access cookie once, on a page URL.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAccessGate } from '@clawboo/gateway-proxy'

import { resetDb } from '../../lib/db'
import { apiRouter } from '../index'

const TOKEN = 'launch-code-test-token'

let dir: string
let prevHome: string | undefined
const running: http.Server[] = []

async function serve(token: string): Promise<string> {
  const gate = createAccessGate({ token })
  const app = express()
  app.set('case sensitive routing', true)
  app.locals['accessGate'] = gate
  app.use(express.json())
  app.use((req, res, next) => {
    if (gate.handleHttp(req, res)) return
    next()
  })
  app.use(apiRouter)
  app.get('/', (_req, res) => {
    res.type('html').send('<!doctype html><title>Clawboo</title>')
  })
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  running.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(() => {
  prevHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-launch-code-'))
  process.env['CLAWBOO_HOME'] = dir
})
afterAll(async () => {
  await Promise.all(running.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  rmSync(dir, { recursive: true, force: true })
})

const withCookie = { cookie: `clawboo_access=${TOKEN}` }
/** The fetch metadata a browser sends when it loads a page. */
const pageLoad = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }

/**
 * A GET with exactly these headers and no redirect-following. Not `fetch`: it
 * sets its own `Sec-Fetch-Mode: cors` over any given, so it cannot load a page.
 */
function getPage(
  url: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; setCookie: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        const cookie = res.headers['set-cookie']
        resolve({
          status: res.statusCode ?? 0,
          setCookie: cookie ? cookie.join('; ') : null,
          body,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('POST /api/access/launch-code on a locked server', () => {
  it('is behind the gate like every other API route', async () => {
    const base = await serve(TOKEN)
    const res = await fetch(`${base}/api/access/launch-code`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('mints a one-time code for a caller holding the cookie, never cached', async () => {
    const base = await serve(TOKEN)
    const before = Date.now()
    const res = await fetch(`${base}/api/access/launch-code`, {
      method: 'POST',
      headers: withCookie,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {
      gated: boolean
      code: string
      expiresAt: number
      expiresInMs: number
    }
    expect(body.gated).toBe(true)
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(body.expiresInMs).toBe(120_000)
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 120_000)
    expect(JSON.stringify(body)).not.toContain(TOKEN)
  })

  it('hands out a code that signs a browser in once', async () => {
    const base = await serve(TOKEN)
    const { code } = (await (
      await fetch(`${base}/api/access/launch-code`, { method: 'POST', headers: withCookie })
    ).json()) as { code: string }

    // A link previewer's fetch (no fetch metadata) gets the sign-in page, and
    // the code is left alone.
    const preview = await getPage(`${base}/?access_code=${code}`)
    expect(preview.status).toBe(200)
    expect(preview.setCookie).toBeNull()

    const first = await getPage(`${base}/?access_code=${code}`, pageLoad)
    expect(first.status).toBe(302)
    expect(first.setCookie).toContain(`clawboo_access=${TOKEN}`)

    const second = await getPage(`${base}/?access_code=${code}`, pageLoad)
    expect(second.status).toBe(302)
    expect(second.setCookie).toBeNull()
  })

  it('signs in a browser that sends no fetch metadata through the sign-in page', async () => {
    // A phone on a plain-HTTP LAN address: its browser sends no Sec-Fetch-*.
    const base = await serve(TOKEN)
    const { code } = (await (
      await fetch(`${base}/api/access/launch-code`, { method: 'POST', headers: withCookie })
    ).json()) as { code: string }

    const page = await getPage(`${base}/?access_code=${code}`)
    expect(page.status).toBe(200)
    expect(page.body).toContain(`action="?access_code=${code}"`)

    // A script's bare POST does not spend it; the page's form POST does.
    const bare = await getPage(`${base}/?access_code=${code}`, {}, 'POST')
    expect(bare.setCookie).toBeNull()
    const posted = await getPage(
      `${base}/?access_code=${code}`,
      { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      'POST',
    )
    expect(posted.status).toBe(303)
    expect(posted.setCookie).toContain(`clawboo_access=${TOKEN}`)
  })

  it('answers only POST', async () => {
    const base = await serve(TOKEN)
    const res = await fetch(`${base}/api/access/launch-code`, { headers: withCookie })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/access/launch-code on a server with no gate', () => {
  it('says no code is needed', async () => {
    const base = await serve('')
    const res = await fetch(`${base}/api/access/launch-code`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ gated: false })
  })
})
