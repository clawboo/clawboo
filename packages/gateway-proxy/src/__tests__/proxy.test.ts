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
