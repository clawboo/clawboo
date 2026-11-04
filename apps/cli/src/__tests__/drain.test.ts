// `clawboo stop` and `clawboo restart` wait for agent runs before they stop the
// server: hold it, poll until no run is going (renewing the hold), then stop.
// The server here is a scripted hold route; every other side effect is injected.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  drainDashboard,
  releaseDashboardHold,
  stopAfterAgentRuns,
  type DrainDeps,
  type JsonReply,
  type Method,
  type StopDeps,
} from '../lifecycle'

const PORT = 18790

/** The hold route's answer with `running` runs going. */
function holdReply(running: number): JsonReply {
  return {
    status: 200,
    ok: true,
    body: {
      held: true,
      holds: [],
      backgroundWork: running > 0 ? 'present' : 'none',
      runs: { running, queued: 0, limit: 8 },
    },
  }
}

interface Call {
  method: Method
  route: string
  body?: unknown
}

/**
 * A server whose runs finish one per poll from `running`, on a clock that moves
 * one second per sleep. Records every request.
 */
function scripted(running: number, opts: { holdRoute?: boolean } = {}) {
  const calls: Call[] = []
  let left = running
  let clock = 0
  const order: string[] = []
  const drain: Required<DrainDeps> = {
    request: async (method, route, body) => {
      calls.push({ method, route, body })
      order.push(`${method} ${route}`)
      if (opts.holdRoute === false) return { status: 404, ok: false, body: { error: 'Not found' } }
      if (method === 'DELETE') return { status: 200, ok: true, body: {} }
      return holdReply(left)
    },
    sleep: async (ms) => {
      clock += ms
      left = Math.max(0, left - 1)
    },
    now: () => clock,
  }
  const stop: StopDeps = {
    isClawboo: async () => {
      order.push('stop')
      return true
    },
    findListenerPid: () => 4242,
    kill: () => {},
    probe: async () => false,
    readPortFile: () => PORT,
    unlinkPortFile: () => {},
    sleep: async () => {},
  }
  return { calls, order, drain, stop, clock: () => clock }
}

describe('drainDashboard', () => {
  it('holds the server, then reports idle at once when no run is going', async () => {
    const s = scripted(0)
    const outcome = await drainDashboard(
      PORT,
      { owner: 'clawboo-stop-1', reason: 'stop', waitMs: 60_000 },
      s.drain,
    )
    expect(outcome).toEqual({ status: 'idle' })
    expect(s.calls).toEqual([
      {
        method: 'POST',
        route: '/api/system/hold',
        body: { owner: 'clawboo-stop-1', ttlSeconds: 60, reason: 'stop' },
      },
    ])
  })

  it('waits while runs are going and says how many are left', async () => {
    const s = scripted(3)
    const seen: number[] = []
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000, onWaiting: (n) => seen.push(n) },
      s.drain,
    )
    expect(outcome).toEqual({ status: 'idle' })
    expect(seen).toEqual([3, 2, 1])
    expect(s.calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET', 'GET'])
  })

  it('renews its hold while it waits, well before the hold would lapse', async () => {
    const s = scripted(45)
    await drainDashboard(PORT, { owner: 'o', reason: 'stop', waitMs: 600_000 }, s.drain)
    const posts = s.calls.filter((c) => c.method === 'POST')
    // One place, then one renewal per 20 s of a 45 s wait.
    expect(posts).toHaveLength(3)
    expect(posts.every((c) => (c.body as { ttlSeconds: number }).ttlSeconds === 60)).toBe(true)
  })

  it('gives up at its bound with the runs still going', async () => {
    const s = scripted(1_000)
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 5_000 },
      s.drain,
    )
    expect(outcome).toEqual({ status: 'timed-out', running: 995 })
    expect(s.clock()).toBe(5_000)
  })

  it('stops waiting when its signal aborts', async () => {
    const s = scripted(10)
    const cancel = new AbortController()
    const outcome = await drainDashboard(
      PORT,
      {
        owner: 'o',
        reason: 'stop',
        waitMs: 60_000,
        signal: cancel.signal,
        onWaiting: (n) => {
          if (n === 8) cancel.abort()
        },
      },
      s.drain,
    )
    expect(outcome).toEqual({ status: 'cancelled', running: 8 })
  })

  it('reports a server with no hold route as unsupported, so the stop goes on as before', async () => {
    const s = scripted(2, { holdRoute: false })
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      s.drain,
    )
    expect(outcome).toEqual({ status: 'unsupported' })
    expect(s.calls).toHaveLength(1)
  })

  it('reports a server that stops answering mid-wait as lost, after three polls in a row', async () => {
    const s = scripted(5)
    let n = 0
    const request: DrainDeps['request'] = async (method, route, body) =>
      ++n > 2 ? null : s.drain.request(method, route, body)
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      { ...s.drain, request },
    )
    expect(outcome).toEqual({ status: 'lost', running: 4 })
    expect(n).toBe(5)
  })

  it('keeps waiting through a poll that fails once', async () => {
    const s = scripted(3)
    let n = 0
    const request: DrainDeps['request'] = async (method, route, body) =>
      ++n === 2 ? null : s.drain.request(method, route, body)
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      { ...s.drain, request },
    )
    expect(outcome).toEqual({ status: 'idle' })
  })
})

describe('stopAfterAgentRuns', () => {
  it('waits for the runs going, then stops the server', async () => {
    const s = scripted(2)
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'stop', waitMs: 60_000 },
      { drain: s.drain, stop: s.stop },
    )
    expect(result.drain).toEqual({ status: 'idle' })
    expect(result.stop).toMatchObject({ status: 'stopped', pid: 4242 })
    // Every poll came before the stop began.
    expect(s.order).toEqual([
      'POST /api/system/hold',
      'GET /api/system/hold',
      'GET /api/system/hold',
      'stop',
    ])
  })

  it('stops at once with force, holding and waiting for nothing', async () => {
    const s = scripted(2)
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'stop', force: true, waitMs: 60_000 },
      { drain: s.drain, stop: s.stop },
    )
    expect(result.drain).toBeNull()
    expect(result.stop?.status).toBe('stopped')
    expect(s.order).toEqual(['stop'])
  })

  it('stops after the bound with runs still going', async () => {
    const s = scripted(100)
    const onStopping = vi.fn()
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'restart', waitMs: 3_000, onStopping },
      { drain: s.drain, stop: s.stop },
    )
    expect(result.drain).toEqual({ status: 'timed-out', running: 97 })
    expect(onStopping).toHaveBeenCalledWith({ status: 'timed-out', running: 97 })
    expect(result.stop?.status).toBe('stopped')
    expect(s.calls[0]!.body).toMatchObject({ owner: `clawboo-restart-${process.pid}` })
  })

  it('stops nothing when the wait is cancelled, and releases its hold', async () => {
    const s = scripted(10)
    const cancel = new AbortController()
    cancel.abort()
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'stop', waitMs: 60_000, signal: cancel.signal },
      { drain: s.drain, stop: s.stop },
    )
    expect(result).toEqual({ drain: { status: 'cancelled', running: 10 }, stop: null })
    expect(s.order).toEqual([
      'POST /api/system/hold',
      `DELETE /api/system/hold/clawboo-stop-${process.pid}`,
    ])
  })

  it('releases its hold when the stop fails, so the server starts work again', async () => {
    const s = scripted(0)
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'stop', waitMs: 60_000 },
      { drain: s.drain, stop: { ...s.stop, findListenerPid: () => null } },
    )
    expect(result.stop).toMatchObject({ status: 'could-not-identify' })
    expect(s.order.at(-1)).toBe(`DELETE /api/system/hold/clawboo-stop-${process.pid}`)
  })
})

describe('the hold requests over HTTP', () => {
  let server: http.Server | null = null
  afterEach(async () => {
    if (!server) return
    const s = server
    server = null
    s.closeAllConnections()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  })

  it('send the hold as JSON and release it by owner', async () => {
    const seen: { method?: string; url?: string; type?: string; body: string }[] = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          type: req.headers['content-type'],
          body,
        })
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            held: req.method !== 'DELETE',
            holds: [],
            backgroundWork: 'none',
            runs: { running: 0, queued: 0, limit: 8 },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    // The launcher dials 127.0.0.1 unless HOST names another loopback address.
    vi.stubEnv('HOST', '')
    const outcome = await drainDashboard(port, {
      owner: 'clawboo-stop-7',
      reason: 'stop',
      waitMs: 1_000,
    })
    expect(outcome).toEqual({ status: 'idle' })
    expect(await releaseDashboardHold(port, 'clawboo-stop-7')).toBe(true)
    vi.unstubAllEnvs()
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/api/system/hold',
        type: 'application/json',
        body: JSON.stringify({ owner: 'clawboo-stop-7', ttlSeconds: 60, reason: 'stop' }),
      },
      { method: 'DELETE', url: '/api/system/hold/clawboo-stop-7', type: undefined, body: '' },
    ])
  })
})
