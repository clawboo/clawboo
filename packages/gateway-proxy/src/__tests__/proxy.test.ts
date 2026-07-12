// First standalone gateway-proxy suite. Drives the proxy with a real HTTP server
// + real browser/upstream WebSockets: a connect-buffer overflow tears the
// connection down (never grows unbounded), and the upstream keepalive keeps a
// healthy connection open (the ping/pong loop doesn't false-terminate).

import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { createGatewayProxy } from '../proxy'
import { createOriginGuard } from '../origin-guard'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  )
}

const quiet = { log: () => undefined, logError: () => undefined }

describe('gateway proxy', () => {
  let home: string
  let prevHome: string | undefined
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-proxy-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home // device-identity writes land in the sandbox
  })
  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('bounds the connect-buffer: a flood before upstream opens closes the connection', async () => {
    // Gate the settings load so the upstream socket is never even constructed
    // (upstreamWs stays null) — every browser frame buffers, and overflow closes
    // the connection with no connecting-socket teardown race.
    let releaseSettings: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      releaseSettings = r
    })
    cleanups.push(() => releaseSettings?.()) // let the eager-connect IIFE finish (it bails: closed)

    const proxyHttp = createServer()
    const proxy = createGatewayProxy({
      loadUpstreamSettings: async () => {
        await gate
        return { url: 'ws://127.0.0.1:1', token: '' }
      },
      maxPendingFrames: 5,
      allowWs: () => true,
      ...quiet,
    })
    proxyHttp.on('upgrade', proxy.handleUpgrade)
    const proxyPort = await listen(proxyHttp)
    cleanups.push(() => proxyHttp.close())

    const browser = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/gateway/ws`)
    cleanups.push(() => browser.terminate())

    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      browser.on('open', () => {
        for (let i = 0; i < 50; i++)
          browser.send(JSON.stringify({ type: 'req', method: 'noop', id: String(i) }))
      })
      browser.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      browser.on('error', reject)
      setTimeout(() => reject(new Error('proxy did not close on buffer overflow')), 4000)
    })
    expect(closeInfo.code).toBe(1011)
    expect(closeInfo.reason).toContain('buffer_overflow')
  })

  it('keepalive keeps a healthy upstream connection open (ping/pong, no false terminate)', async () => {
    // A real upstream that auto-pongs (ws default). The proxy pings every 60ms;
    // a healthy connection must survive several cycles without being terminated.
    const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => upstream.on('listening', r))
    const upPort = (upstream.address() as { port: number }).port
    cleanups.push(() => upstream.close())

    const proxyHttp = createServer()
    const proxy = createGatewayProxy({
      loadUpstreamSettings: async () => ({ url: `ws://127.0.0.1:${upPort}`, token: '' }),
      keepaliveIntervalMs: 60,
      allowWs: () => true,
      ...quiet,
    })
    proxyHttp.on('upgrade', proxy.handleUpgrade)
    const proxyPort = await listen(proxyHttp)
    cleanups.push(() => proxyHttp.close())

    const browser = new WebSocket(`ws://127.0.0.1:${proxyPort}/api/gateway/ws`)
    cleanups.push(() => browser.terminate())
    await new Promise<void>((res, rej) => {
      browser.on('open', () => res())
      browser.on('error', rej)
      setTimeout(() => rej(new Error('browser never connected')), 3000)
    })

    let closed = false
    browser.on('close', () => {
      closed = true
    })
    // Several keepalive cycles (interval 60ms): a healthy auto-ponging upstream
    // must NOT be terminated.
    await new Promise((r) => setTimeout(r, 300))
    expect(closed).toBe(false)
    expect(browser.readyState).toBe(WebSocket.OPEN)
  })
})

describe('gateway proxy — CSWSH origin guard (wired like the server upgrade handler)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
  })

  // Mirror apps/web/server/index.ts: guard the upgrade, 403 a foreign Origin before
  // ever reaching the proxy. Returns the bound port so the caller can form the
  // same-origin allowlist entry.
  async function startGuardedProxy(): Promise<number> {
    const proxyHttp = createServer()
    const port = await listen(proxyHttp)
    cleanups.push(() => proxyHttp.close())
    const guard = createOriginGuard({ port })
    const proxy = createGatewayProxy({
      // A dead upstream is fine — we only assert the UPGRADE outcome, which
      // completes independently of the upstream connection.
      loadUpstreamSettings: async () => ({ url: 'ws://127.0.0.1:1', token: '' }),
      allowWs: () => true,
      ...quiet,
    })
    proxyHttp.on('upgrade', (req, socket, head) => {
      if (!guard.allowUpgrade(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      proxy.handleUpgrade(req, socket, head)
    })
    return port
  }

  it('REJECTS a real WS handshake carrying a foreign Origin (403, never opens)', async () => {
    const port = await startGuardedProxy()
    const browser = new WebSocket(`ws://127.0.0.1:${port}/api/gateway/ws`, {
      origin: 'http://evil.com',
    })
    cleanups.push(() => browser.terminate())

    const result = await new Promise<{ opened: boolean; status?: number }>((resolve) => {
      browser.on('open', () => resolve({ opened: true }))
      browser.on('unexpected-response', (_req, res) =>
        resolve({ opened: false, status: res.statusCode }),
      )
      browser.on('error', () => resolve({ opened: false }))
      setTimeout(() => resolve({ opened: false, status: -1 }), 3000)
    })
    expect(result.opened).toBe(false)
    if (result.status !== undefined && result.status > 0) expect(result.status).toBe(403)
  })

  it('ALLOWS a real WS handshake carrying the same-origin Origin', async () => {
    const port = await startGuardedProxy()
    const browser = new WebSocket(`ws://127.0.0.1:${port}/api/gateway/ws`, {
      origin: `http://127.0.0.1:${port}`,
    })
    cleanups.push(() => browser.terminate())

    const opened = await new Promise<boolean>((resolve) => {
      browser.on('open', () => resolve(true))
      browser.on('unexpected-response', () => resolve(false))
      browser.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 3000)
    })
    expect(opened).toBe(true)
  })
})
