// A server started with STUDIO_ACCESS_TOKEN answers every /api/* request without
// the access cookie with a 401. The launcher hands its own environment to the
// server it starts, so it holds that token, and it has to use it: without it the
// readiness poll never recognised the server it had just started, waited about
// 45 seconds, printed "Dashboard is taking too long to start." and exited 1 while
// the server kept running.
//
// These tests use real HTTP servers and the real `fetch`, so they also prove the
// Cookie header actually goes out.

import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return {
    ...real,
    fork: () => ({ unref() {}, channel: { unref() {} }, on() {} }),
  }
})

import { discoverDashboard, fetchServerVersion, probeDashboard, startDashboard } from '../lifecycle'

const TOKEN = 'test-token-1234'

// The exact body packages/gateway-proxy/src/access-gate.ts writes on a 401.
const GATE_401 = {
  error: 'Clawboo access token required. Open /?access_token=<token> once to set a cookie.',
}
const CLAWBOO_SETTINGS = { gatewayUrl: 'http://localhost:18789', hasToken: false }

interface FakeServer {
  port: number
  /** The Cookie header of every request, in order ('' when none was sent). */
  cookies: string[]
  close: () => Promise<void>
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function listen(handler: http.RequestListener, cookies: string[]): Promise<FakeServer> {
  const server = http.createServer((req, res) => {
    cookies.push(req.headers.cookie ?? '')
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    cookies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A Clawboo dashboard behind the access gate, with the gate's cookie rule. */
function gatedDashboard(token: string): Promise<FakeServer> {
  return listen((req, res) => {
    if (req.headers.cookie !== `clawboo_access=${token}`) return sendJson(res, 401, GATE_401)
    if (req.url === '/api/settings') return sendJson(res, 200, CLAWBOO_SETTINGS)
    if (req.url?.startsWith('/api/system/self-version')) {
      return sendJson(res, 200, { current: '0.5.0' })
    }
    sendJson(res, 404, { error: 'not found' })
  }, [])
}

let servers: FakeServer[] = []
let home: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['STUDIO_ACCESS_TOKEN', 'CLAWBOO_API_PORT', 'CLAWBOO_HOME'] as const

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-cli-gated-')))
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
})

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

async function track(server: Promise<FakeServer>): Promise<FakeServer> {
  const s = await server
  servers.push(s)
  return s
}

describe('a token-gated dashboard', () => {
  it('reports the server it just started as started when the launcher holds the token', async () => {
    process.env['STUDIO_ACCESS_TOKEN'] = TOKEN
    const gated = await track(gatedDashboard(TOKEN))
    const realExists = fs.existsSync
    // Pretend the bundled server.js sits next to the launcher, as it does in a
    // published install. `fork` is mocked; the fake server stands in for it.
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(`${path.sep}server.js`) ? true : realExists(p),
    )

    const outcome = await startDashboard({ port: gated.port, maxAttempts: 2 })

    expect(outcome).toEqual({ status: 'started', port: gated.port, mode: 'bundled' })
  })

  it('is found by discovery, so stop, restart and attach can use it', async () => {
    process.env['STUDIO_ACCESS_TOKEN'] = ` ${TOKEN} `
    const gated = await track(gatedDashboard(TOKEN))
    process.env['CLAWBOO_API_PORT'] = String(gated.port)

    expect(await probeDashboard('127.0.0.1', gated.port, 1_000)).toBe('clawboo')
    expect(await discoverDashboard()).toEqual({ port: gated.port, gatedPort: null })
    expect(await fetchServerVersion(gated.port)).toBe('0.5.0')
  })

  it('stays gated without a token, or with the wrong one', async () => {
    const gated = await track(gatedDashboard(TOKEN))

    delete process.env['STUDIO_ACCESS_TOKEN']
    expect(await probeDashboard('127.0.0.1', gated.port, 1_000)).toBe('gated')

    process.env['STUDIO_ACCESS_TOKEN'] = 'some-other-token'
    expect(await probeDashboard('127.0.0.1', gated.port, 1_000)).toBe('gated')
  })

  it('sends the token only to a port that answered with the access gate refusal', async () => {
    process.env['STUDIO_ACCESS_TOKEN'] = TOKEN
    const gated = await track(gatedDashboard(TOKEN))
    // Something else in the port window that also refuses with a JSON 401.
    const other = await track(
      listen((_req, res) => sendJson(res, 401, { error: 'Unauthorized' }), []),
    )

    expect(await probeDashboard('127.0.0.1', other.port, 1_000)).toBe('none')
    expect(other.cookies).toEqual([''])

    expect(await probeDashboard('127.0.0.1', gated.port, 1_000)).toBe('clawboo')
    expect(gated.cookies).toEqual(['', `clawboo_access=${TOKEN}`])
  })
})
