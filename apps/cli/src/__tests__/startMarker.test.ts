// The CLI checks the start marker (api-port.json) before it trusts the port in
// api-port.txt. A server that died hard leaves both files behind, and any
// program can take its port: the record must then count for nothing, neither
// for the access token nor as a busy server holding the port. With no marker
// (a server from before it), the port file counts on its own, as it always did.
//
// Real HTTP and TCP servers on loopback, real process checks against this test
// process and a real child; the files live in a sandboxed CLAWBOO_HOME.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { currentEngineIdentity, processStartTimes } from '@clawboo/process-lookup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A namespace import, so the behavioural checks below still run (and fail)
// against a lifecycle.ts from before the marker, which has no
// `readRecordedPort`.
import * as lifecycle from '../lifecycle'
import { startListening } from './startListening'

// The start-time probe the CLI uses, which the cases below shift (the pid of a
// server that died, handed to a process that started later) or break (a host
// whose probe cannot run, or a Windows one that timed out).
const probe = vi.hoisted(() => ({ shiftMs: 0, broken: false }))
vi.mock('@clawboo/process-lookup', async (orig) => {
  const real = await orig<typeof import('@clawboo/process-lookup')>()
  return {
    ...real,
    startTimesReader: (windowsTimeoutMs: number) => {
      const read = real.startTimesReader(windowsTimeoutMs)
      return (safe: readonly number[]) => {
        if (probe.broken) return { ok: false, times: new Map<number, number>(), error: 'stand-in' }
        const got = read(safe)
        if (probe.shiftMs === 0) return got
        const times = new Map([...got.times].map(([pid, t]) => [pid, t + probe.shiftMs]))
        return { ...got, times }
      }
    },
  }
})

const TOKEN = 'test-token-5678'
const GATE_401 = {
  error: 'Clawboo access token required. Open /?access_token=<token> once to set a cookie.',
}

let home: string
const closers: (() => Promise<void>)[] = []

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-cli-marker-')))
  vi.stubEnv('CLAWBOO_HOME', home)
  vi.stubEnv('HOST', '')
  vi.stubEnv('CLAWBOO_API_PORT', '')
  vi.stubEnv('STUDIO_ACCESS_TOKEN', TOKEN)
  lifecycle.resetMarkerCheckForTests?.()
  probe.shiftMs = 0
  probe.broken = false
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

const portFile = () => path.join(home, 'api-port.txt')
const markerFile = () => path.join(home, 'api-port.json')

function recordPort(port: number): void {
  fs.writeFileSync(portFile(), String(port))
}

/** The marker this test process would write as a server on `port`. */
const liveMarker = (port: number) => ({ port, ...currentEngineIdentity(), version: '0.9.0' })

function writeMarker(m: object): void {
  fs.writeFileSync(markerFile(), JSON.stringify(m))
}

/**
 * A dashboard behind the access gate: 401 unless the cookie holds the token.
 * Discovery is pinned to its port (CLAWBOO_API_PORT), so a dashboard this
 * machine really runs in 18790-18809 never answers a test. That env var never
 * qualifies a port for the token on its own: the recorded port still decides.
 */
async function gatedDashboard(): Promise<{ port: number; cookies: string[] }> {
  const cookies: string[] = []
  const server = http.createServer((req, res) => {
    cookies.push(req.headers.cookie ?? '')
    res.setHeader('Content-Type', 'application/json')
    if (req.headers.cookie !== `clawboo_access=${TOKEN}`) {
      res.statusCode = 401
      res.end(JSON.stringify(GATE_401))
      return
    }
    res.end(JSON.stringify({ gatewayUrl: 'ws://127.0.0.1:18789', hasToken: true }))
  })
  await startListening(server, '127.0.0.1')
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = (server.address() as AddressInfo).port
  vi.stubEnv('CLAWBOO_API_PORT', String(port))
  return { port, cookies }
}

/** A port that takes connections and never answers. */
async function silentPort(): Promise<number> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await startListening(server, '127.0.0.1')
  closers.push(async () => {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as AddressInfo).port
}

const withToken = `clawboo_access=${TOKEN}`

describe('the access token and the start marker', () => {
  it('goes to the recorded port when the marker names a running server', async () => {
    const gated = await gatedDashboard()
    recordPort(gated.port)
    writeMarker(liveMarker(gated.port))
    expect(await lifecycle.discoverDashboard()).toEqual({ port: gated.port, gatedPort: null })
    expect(gated.cookies).toContain(withToken)
    expect(lifecycle.readRecordedPort()).toMatchObject({ port: gated.port, trust: 'verified' })
  })

  it('never goes to a port whose marker names a dead pid', async () => {
    const gated = await gatedDashboard()
    recordPort(gated.port)
    writeMarker({ ...liveMarker(gated.port), pid: 99_999_999 })
    const found = await lifecycle.discoverDashboard()
    expect(gated.cookies).not.toContain(withToken)
    expect(found.port).toBeNull()
    expect(lifecycle.readRecordedPort()).toMatchObject({ port: gated.port, trust: 'stale' })
  })

  it('never goes to a port whose marker names a reused pid (it started at another time)', async () => {
    const gated = await gatedDashboard()
    recordPort(gated.port)
    const me = liveMarker(gated.port)
    writeMarker({ ...me, startedAt: me.startedAt - 3_600_000 })
    expect((await lifecycle.discoverDashboard()).port).toBeNull()
    expect(gated.cookies).not.toContain(withToken)
    expect(lifecycle.readRecordedPort().trust).toBe('stale')
  })

  it('checks a running server again on each request, so a pid reused mid-command gets no token', async () => {
    const gated = await gatedDashboard()
    recordPort(gated.port)
    writeMarker(liveMarker(gated.port))
    expect(lifecycle.readRecordedPort().trust).toBe('verified')
    // The server dies hard (both files stay) and its pid goes to a process that
    // started an hour later, which takes the port too.
    probe.shiftMs = 3_600_000
    expect(lifecycle.readRecordedPort().trust).toBe('stale')
    expect((await lifecycle.discoverDashboard()).port).toBeNull()
    expect(gated.cookies).not.toContain(withToken)
  })

  it('falls back to the port file alone when there is no marker, as before it', async () => {
    const gated = await gatedDashboard()
    recordPort(gated.port)
    // First a stale marker: no token. Then the marker goes: the port file alone
    // counts, as it did for a server from before the marker.
    writeMarker({ ...liveMarker(gated.port), pid: 99_999_999 })
    expect((await lifecycle.discoverDashboard()).port).toBeNull()
    fs.rmSync(markerFile())
    expect(await lifecycle.discoverDashboard()).toEqual({ port: gated.port, gatedPort: null })
    expect(gated.cookies).toContain(withToken)
    expect(lifecycle.readRecordedPort()).toMatchObject({ port: gated.port, trust: 'unverified' })
  })

  it('reads a server that dies while the command runs as gone, though the check is cached', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    closers.push(async () => {
      child.kill('SIGKILL')
    })
    await new Promise((r) => setTimeout(r, 200))
    const started = processStartTimes([child.pid!]).times.get(child.pid!)
    expect(started).toBeDefined()
    recordPort(18790)
    writeMarker({ ...liveMarker(18790), pid: child.pid!, startedAt: started! })
    expect(lifecycle.readRecordedPort().trust).toBe('verified')
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGKILL')
    await exited
    expect(lifecycle.readRecordedPort().trust).toBe('stale')
  })

  it('reads a server that dies while the command runs as gone, though its start time could not be read', async () => {
    probe.broken = true
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    closers.push(async () => {
      child.kill('SIGKILL')
    })
    await new Promise((r) => setTimeout(r, 200))
    const gated = await gatedDashboard()
    recordPort(gated.port)
    writeMarker({ ...liveMarker(gated.port), pid: child.pid! })
    // No start time to go by: the port file counts on its own, as before the marker.
    expect(lifecycle.readRecordedPort().trust).toBe('unverified')
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGKILL')
    await exited
    // Its pid is free now, and its port anyone's: no token.
    expect(lifecycle.readRecordedPort().trust).toBe('stale')
    expect((await lifecycle.discoverDashboard()).port).toBeNull()
    expect(gated.cookies).not.toContain(withToken)
  })
})

describe('inspectRecordedPort and the start marker', () => {
  it('reads a silent port as a stale record when the marker shows its server is gone', async () => {
    const port = await silentPort()
    recordPort(port)
    writeMarker({ ...liveMarker(port), pid: 99_999_999 })
    expect(await lifecycle.inspectRecordedPort({ timeoutMs: 300 })).toEqual({ port, state: 'none' })
  })

  it('still reads a silent port as a busy server when the marker names a running one', async () => {
    const port = await silentPort()
    recordPort(port)
    writeMarker(liveMarker(port))
    expect(await lifecycle.inspectRecordedPort({ timeoutMs: 300 })).toEqual({
      port,
      state: 'silent',
    })
  })

  it('with no marker, reads the port as before the marker existed', async () => {
    const port = await silentPort()
    recordPort(port)
    expect(await lifecycle.inspectRecordedPort({ timeoutMs: 300 })).toEqual({
      port,
      state: 'silent',
    })
  })
})

describe('removeRuntimePortFile and the start marker', () => {
  it('takes a marker naming a dead server with the port file', () => {
    recordPort(18790)
    writeMarker({ ...liveMarker(18790), pid: 99_999_999 })
    lifecycle.removeRuntimePortFile()
    expect(fs.existsSync(portFile())).toBe(false)
    expect(fs.existsSync(markerFile())).toBe(false)
  })

  it("leaves a marker naming a running server: it is another server's", () => {
    recordPort(18795)
    writeMarker(liveMarker(18790))
    lifecycle.removeRuntimePortFile()
    expect(fs.existsSync(portFile())).toBe(false)
    expect(fs.existsSync(markerFile())).toBe(true)
  })
})
