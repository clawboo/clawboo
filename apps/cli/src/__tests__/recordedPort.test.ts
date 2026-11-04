// When discovery finds no Clawboo answer, what holds the port the server
// recorded in api-port.txt decides what `clawboo stop` and `clawboo restart`
// may do. A server too busy to answer still takes connections, so it reads as
// `silent`: its record must stay and no second server may start beside it.
// Real sockets on loopback; the record lives in a sandboxed CLAWBOO_HOME.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { inspectRecordedPort } from '../lifecycle'

let home: string
const closers: (() => Promise<void>)[] = []

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-recorded-port-'))
  vi.stubEnv('CLAWBOO_HOME', home)
  vi.stubEnv('HOST', '')
  vi.stubEnv('STUDIO_ACCESS_TOKEN', '')
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function record(port: number): void {
  writeFileSync(path.join(home, 'api-port.txt'), String(port))
}

/** A TCP server; `onSocket` decides what each connection gets. */
async function tcpServer(onSocket: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onSocket(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as AddressInfo).port
}

/** An HTTP server that answers every request with `status` and a JSON or HTML body. */
async function httpServer(status: number, body: unknown, html = false): Promise<number> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.statusCode = status
    res.setHeader('Content-Type', html ? 'text/html' : 'application/json')
    res.end(html ? String(body) : JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as AddressInfo).port
}

describe('inspectRecordedPort', () => {
  it('reads a server that takes connections and never answers as silent', async () => {
    // A wedged server: the kernel accepts, nothing ever writes back.
    const port = await tcpServer(() => {})
    record(port)
    expect(await inspectRecordedPort({ timeoutMs: 300 })).toEqual({ port, state: 'silent' })
  })

  it('reads a Clawboo server that answers as live, with or without its access gate', async () => {
    const open = await httpServer(200, { gatewayUrl: 'ws://127.0.0.1:18789', hasToken: false })
    record(open)
    expect(await inspectRecordedPort({ timeoutMs: 1_000 })).toEqual({ port: open, state: 'live' })

    const gated = await httpServer(401, {
      error: 'Clawboo access token required.',
      gate: 'clawboo-access',
    })
    record(gated)
    expect(await inspectRecordedPort({ timeoutMs: 1_000 })).toEqual({ port: gated, state: 'live' })
  })

  it('reads a program that answers and is not Clawboo as a stale record', async () => {
    const port = await httpServer(200, '<!doctype html><title>DevTools</title>', true)
    record(port)
    expect(await inspectRecordedPort({ timeoutMs: 1_000 })).toEqual({ port, state: 'none' })
  })

  it('reads a service that drops the connection at once as a stale record, not as silent', async () => {
    const port = await tcpServer((socket) => socket.destroy())
    record(port)
    expect(await inspectRecordedPort({ timeoutMs: 1_000 })).toEqual({ port, state: 'none' })
  })

  it('reads a free port, or no record at all, as nothing there', async () => {
    const port = await tcpServer(() => {})
    await closers.pop()!()
    record(port)
    expect(await inspectRecordedPort({ timeoutMs: 300 })).toEqual({ port, state: 'none' })

    rmSync(path.join(home, 'api-port.txt'))
    expect(await inspectRecordedPort({ timeoutMs: 300 })).toEqual({ port: null, state: 'none' })
  })
})
