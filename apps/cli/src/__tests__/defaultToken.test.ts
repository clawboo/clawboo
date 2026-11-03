// The default per-install token. With STUDIO_ACCESS_TOKEN unset, the server
// locks itself with the token in <CLAWBOO_HOME>/access-token, so the launcher
// reads that file to reach it, and opens the browser with a one-time launch code
// (never the token) so the browser gets the cookie.
//
// Real HTTP servers and the real `fetch`, so the Cookie header is proven to go
// out, and to go out only where it should.

import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  dashboardUrl,
  discoverDashboard,
  launcherAccessToken,
  mintLaunchCode,
  openUrlInBrowser,
  probeDashboard,
} from '../lifecycle'

const FILE_TOKEN = 'file-token-abc_123'

const GATE_401 = {
  error:
    'Clawboo access token required. Run `clawboo open` on the computer running Clawboo, ' +
    'or open /?access_token=<token> once to set a cookie.',
  gate: 'clawboo-access',
}
const CLAWBOO_SETTINGS = { gatewayUrl: 'http://localhost:18789', hasToken: false }

interface Seen {
  method: string
  url: string
  cookie: string
}

interface FakeServer {
  port: number
  seen: Seen[]
  close: () => Promise<void>
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function listen(handler: http.RequestListener): Promise<FakeServer> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', cookie: req.headers.cookie ?? '' })
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A dashboard behind the gate, with a launch-code route like the real one. */
function gatedDashboard(token: string): Promise<FakeServer> {
  return listen((req, res) => {
    if (req.headers.cookie !== `clawboo_access=${token}`) return sendJson(res, 401, GATE_401)
    if (req.url === '/api/settings') return sendJson(res, 200, CLAWBOO_SETTINGS)
    if (req.method === 'POST' && req.url === '/api/access/launch-code') {
      return sendJson(res, 200, { gated: true, code: 'one-time-code_XYZ', expiresAt: 123 })
    }
    sendJson(res, 404, { error: 'not found' })
  })
}

let servers: FakeServer[] = []
let home: string
let clawbooHome: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'STUDIO_ACCESS_TOKEN',
  'CLAWBOO_API_PORT',
  'CLAWBOO_HOME',
  'CLAWBOO_BASE_PATH',
] as const

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-cli-default-token-')))
  clawbooHome = path.join(home, '.clawboo')
  process.env['CLAWBOO_HOME'] = clawbooHome
})

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(home, { recursive: true, force: true })
})

async function track(server: Promise<FakeServer>): Promise<FakeServer> {
  const s = await server
  servers.push(s)
  return s
}

function writeSharedToken(token: string): void {
  fs.mkdirSync(clawbooHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(clawbooHome, 'access-token'), token, { mode: 0o600 })
}

/** What the real server writes once it is listening. */
function writePortFile(port: number): void {
  fs.mkdirSync(clawbooHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(clawbooHome, 'api-port.txt'), String(port))
}

describe('launcherAccessToken', () => {
  it('reads the shared file when STUDIO_ACCESS_TOKEN is unset', () => {
    writeSharedToken(FILE_TOKEN)
    expect(launcherAccessToken()).toBe(FILE_TOKEN)
  })

  it('prefers STUDIO_ACCESS_TOKEN over the file', () => {
    writeSharedToken(FILE_TOKEN)
    process.env['STUDIO_ACCESS_TOKEN'] = 'env-token'
    expect(launcherAccessToken()).toBe('env-token')
  })

  it('holds no token when STUDIO_ACCESS_TOKEN is set blank, whatever the file says', () => {
    writeSharedToken(FILE_TOKEN)
    process.env['STUDIO_ACCESS_TOKEN'] = ''
    expect(launcherAccessToken()).toBeNull()
  })

  it('is null with no variable and no file, and never creates the file', () => {
    expect(launcherAccessToken()).toBeNull()
    expect(fs.existsSync(path.join(clawbooHome, 'access-token'))).toBe(false)
  })
})

describe('a dashboard locked with the default token', () => {
  it('is usable once the launcher reads the shared file', async () => {
    writeSharedToken(FILE_TOKEN)
    const gated = await track(gatedDashboard(FILE_TOKEN))
    writePortFile(gated.port)
    process.env['CLAWBOO_API_PORT'] = String(gated.port)

    expect(await probeDashboard('127.0.0.1', gated.port, 1_000)).toBe('clawboo')
    expect(await discoverDashboard()).toEqual({ port: gated.port, gatedPort: null })
  })

  it('is gated when the file holds some other token', async () => {
    writeSharedToken('stale-token')
    const gated = await track(gatedDashboard(FILE_TOKEN))
    expect(await probeDashboard('127.0.0.1', gated.port, 1_000)).toBe('gated')
  })
})

describe('mintLaunchCode', () => {
  it('asks the gated server for a one-time code with the token as the cookie', async () => {
    writeSharedToken(FILE_TOKEN)
    const gated = await track(gatedDashboard(FILE_TOKEN))
    writePortFile(gated.port)

    expect(await mintLaunchCode(gated.port)).toEqual({
      gated: true,
      code: 'one-time-code_XYZ',
      expiresAt: 123,
    })
    // First without the cookie; with it only after the gate's own refusal.
    expect(gated.seen).toEqual([
      { method: 'POST', url: '/api/access/launch-code', cookie: '' },
      { method: 'POST', url: '/api/access/launch-code', cookie: `clawboo_access=${FILE_TOKEN}` },
    ])
  })

  it('reports a server with no gate', async () => {
    const open = await track(
      listen((req, res) =>
        req.url === '/api/access/launch-code'
          ? sendJson(res, 200, { gated: false })
          : sendJson(res, 404, {}),
      ),
    )
    expect(await mintLaunchCode(open.port)).toEqual({ gated: false })
  })

  it('is null for a server that has no launch-code route (an older version)', async () => {
    writeSharedToken(FILE_TOKEN)
    const old = await track(
      listen((req, res) =>
        req.headers.cookie === `clawboo_access=${FILE_TOKEN}`
          ? sendJson(res, 404, { error: 'Not found' })
          : sendJson(res, 401, GATE_401),
      ),
    )
    writePortFile(old.port)
    expect(await mintLaunchCode(old.port)).toBeNull()
    expect(old.seen.map((s) => s.cookie)).toEqual(['', `clawboo_access=${FILE_TOKEN}`])
  })

  it('is null when the launcher holds no token the server accepts', async () => {
    const gated = await track(gatedDashboard(FILE_TOKEN))
    writePortFile(gated.port)
    expect(await mintLaunchCode(gated.port)).toBeNull()
  })

  it('never sends the token to a port that did not answer with the gate refusal', async () => {
    writeSharedToken(FILE_TOKEN)
    const other = await track(listen((_req, res) => sendJson(res, 401, { error: 'Unauthorized' })))
    expect(await mintLaunchCode(other.port)).toBeNull()
    expect(other.seen.map((s) => s.cookie)).toEqual([''])
  })

  it('refuses a malformed code', async () => {
    const odd = await track(
      listen((_req, res) =>
        sendJson(res, 200, { gated: true, code: 'has space&x=1', expiresAt: 1 }),
      ),
    )
    expect(await mintLaunchCode(odd.port)).toBeNull()
  })
})

describe('who may receive the token', () => {
  // `localhost` can resolve to ::1 first, where another user's program may listen
  // on the very port the server holds on 127.0.0.1 and imitate the gate's 401.
  // So the launcher dials 127.0.0.1, and sends the token only to the port the
  // server recorded in the private api-port.txt, as the desktop app does.
  it('never sends it to a port that imitates the gate but is not the recorded one', async () => {
    writeSharedToken(FILE_TOKEN)
    const real = await track(gatedDashboard(FILE_TOKEN))
    const impostor = await track(gatedDashboard('anything'))
    writePortFile(real.port)

    expect(await probeDashboard('127.0.0.1', impostor.port, 1_000)).toBe('gated')
    expect(await mintLaunchCode(impostor.port)).toBeNull()
    expect(impostor.seen.map((s) => s.cookie)).toEqual(['', ''])

    expect(await probeDashboard('127.0.0.1', real.port, 1_000)).toBe('clawboo')
  })

  it('never sends it to a port that only CLAWBOO_API_PORT names', async () => {
    writeSharedToken(FILE_TOKEN)
    const gated = await track(gatedDashboard(FILE_TOKEN))
    process.env['CLAWBOO_API_PORT'] = String(gated.port)
    expect(await probeDashboard('127.0.0.1', gated.port, 1_000)).toBe('gated')
    expect(gated.seen.map((s) => s.cookie)).toEqual([''])
  })

  it('never sends it to another host, even on the recorded port', async () => {
    writeSharedToken(FILE_TOKEN)
    const gated = await track(gatedDashboard(FILE_TOKEN))
    writePortFile(gated.port)
    expect(await probeDashboard('localhost', gated.port, 1_000)).not.toBe('clawboo')
    expect(gated.seen.every((s) => s.cookie === '')).toBe(true)
  })
})

describe('dashboardUrl', () => {
  it('is the plain URL on 127.0.0.1 without a code', () => {
    expect(dashboardUrl(18790)).toBe('http://127.0.0.1:18790')
  })

  it('carries a launch code as access_code, never as access_token', () => {
    expect(dashboardUrl(18790, 'abc_123')).toBe('http://127.0.0.1:18790/?access_code=abc_123')
  })

  it('stays under a mount', () => {
    process.env['CLAWBOO_BASE_PATH'] = '/clawboo'
    expect(dashboardUrl(18790)).toBe('http://127.0.0.1:18790/clawboo/')
    expect(dashboardUrl(18790, 'abc')).toBe('http://127.0.0.1:18790/clawboo/?access_code=abc')
  })
})

describe('openUrlInBrowser', () => {
  it('is true when the opener command succeeds', async () => {
    const calls: string[] = []
    const ok = await openUrlInBrowser('http://localhost:1/', (cmd, cb) => {
      calls.push(cmd)
      cb(null)
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('"http://localhost:1/"')
  })

  it('is false when there is no browser to open (headless Linux without xdg-open)', async () => {
    const ok = await openUrlInBrowser('http://localhost:1/', (_cmd, cb) =>
      cb(Object.assign(new Error('xdg-open: not found'), { code: 127 })),
    )
    expect(ok).toBe(false)
  })
})
