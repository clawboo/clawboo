// `clawboo stop` and `clawboo restart` wait for agent runs before they stop the
// server: hold it, poll until no run is going (renewing the hold), then stop.
// The server here is a scripted hold route; every other side effect is injected.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  drainDashboard,
  releaseDashboardHold,
  stopAfterAgentRuns,
  waitSecondsFrom,
  type DrainDeps,
  type JsonReply,
  type Method,
  type StopDeps,
} from '../lifecycle'

const PORT = 18790

/** The hold route's answer with `running` runs going and these owners holding. */
function holdReply(running: number, owners: Iterable<string> = []): JsonReply {
  const holds = [...owners].map((owner) => ({ owner }))
  return {
    status: 200,
    ok: true,
    body: {
      held: holds.length > 0,
      holds,
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
  /** Owners holding now: a POST adds one, a DELETE removes it. */
  const owners = new Set<string>()
  const drain: Required<DrainDeps> = {
    request: async (method, route, body) => {
      calls.push({ method, route, body })
      order.push(`${method} ${route}`)
      if (opts.holdRoute === false) return { status: 404, ok: false, body: { error: 'Not found' } }
      if (method === 'DELETE') {
        owners.delete(decodeURIComponent(route.split('/').pop()!))
        return { status: 200, ok: true, body: {} }
      }
      if (method === 'POST') owners.add((body as { owner: string }).owner)
      return holdReply(left, owners)
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
  return { calls, order, owners, drain, stop, clock: () => clock }
}

/** A request seam that answers each call from `answers` in turn, then defers to `then`. */
function answering(
  answers: (JsonReply | null)[],
  then: DrainDeps['request'],
): NonNullable<DrainDeps['request']> {
  let n = 0
  return async (method, route, body) =>
    n < answers.length ? answers[n++]! : then!(method, route, body)
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

describe('drainDashboard: the first hold', () => {
  it('asks again after a request that got no answer, then waits as usual', async () => {
    const s = scripted(1)
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      { ...s.drain, request: answering([null], s.drain.request) },
    )
    expect(outcome).toEqual({ status: 'idle' })
  })

  it('asks again after a server error rather than reading it as an old server', async () => {
    const s = scripted(0)
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      {
        ...s.drain,
        request: answering([{ status: 503, ok: false, body: { error: 'busy' } }], s.drain.request),
      },
    )
    expect(outcome).toEqual({ status: 'idle' })
  })

  it('gives up as unreachable after three tries with no usable answer', async () => {
    const s = scripted(0)
    let tries = 0
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      {
        ...s.drain,
        request: async () => {
          tries += 1
          return null
        },
      },
    )
    expect(outcome).toEqual({ status: 'unreachable' })
    expect(tries).toBe(3)
  })

  it("reads an older server's page (a 200 that is not the hold's answer) as unsupported", async () => {
    const s = scripted(0)
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      {
        ...s.drain,
        request: answering([{ status: 200, ok: true, body: null }], s.drain.request),
      },
    )
    expect(outcome).toEqual({ status: 'unsupported' })
  })

  it('reports a cancel that came while the hold was asked for, even with no run going', async () => {
    const s = scripted(0)
    const cancel = new AbortController()
    cancel.abort()
    const outcome = await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000, signal: cancel.signal },
      s.drain,
    )
    expect(outcome).toEqual({ status: 'cancelled', running: 0 })
  })

  it('places its hold again at once when a poll finds it gone', async () => {
    const s = scripted(3)
    const seen: string[] = []
    const request: DrainDeps['request'] = async (method, route, body) => {
      seen.push(method)
      // The server restarts after the first answer: every hold is gone.
      if (seen.length === 2) s.owners.clear()
      return s.drain.request(method, route, body)
    }
    await drainDashboard(
      PORT,
      { owner: 'o', reason: 'stop', waitMs: 60_000 },
      { ...s.drain, request },
    )
    // POST, then the GET that finds no hold, then a POST at once, not 20 s later.
    expect(seen.slice(0, 3)).toEqual(['POST', 'GET', 'POST'])
  })
})

describe('waitSecondsFrom', () => {
  it.each([
    ['0', 0],
    ['600', 600],
    [' 30 ', 30],
  ])('accepts %j', (value, seconds) => {
    expect(waitSecondsFrom(value)).toBe(seconds)
  })

  it.each(['-1', '1.5', '1e306', '9007199254740993', 'abc', '', '0x10'])(
    'refuses %j, so the wait stays finite',
    (value) => {
      expect(waitSecondsFrom(value)).toBeNull()
    },
  )
})

describe('releaseDashboardHold', () => {
  it('asks twice, and says so when neither try released the hold', async () => {
    let tries = 0
    const released = await releaseDashboardHold(PORT, 'o', {
      request: async () => {
        tries += 1
        return null
      },
    })
    expect(released).toBe(false)
    expect(tries).toBe(2)
  })

  it('counts a hold that is already gone (404) as released', async () => {
    const released = await releaseDashboardHold(PORT, 'o', {
      request: async () => ({ status: 404, ok: false, body: { error: 'No hold' } }),
    })
    expect(released).toBe(true)
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
    expect(result).toEqual({
      drain: { status: 'cancelled', running: 10 },
      stop: null,
      released: true,
    })
    expect(s.order).toEqual([
      'POST /api/system/hold',
      `DELETE /api/system/hold/clawboo-stop-${process.pid}`,
    ])
  })

  it('stops nothing when the server would not be held, and releases what it may have placed', async () => {
    const s = scripted(2)
    let n = 0
    const request: DrainDeps['request'] = async (method, route, body) =>
      ++n <= 3 ? null : s.drain.request(method, route, body)
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'stop', waitMs: 60_000 },
      { drain: { ...s.drain, request }, stop: s.stop },
    )
    expect(result).toEqual({ drain: { status: 'unreachable' }, stop: null, released: true })
    expect(s.order).toEqual([`DELETE /api/system/hold/clawboo-stop-${process.pid}`])
  })

  it('says when a cancelled wait could not release its hold', async () => {
    const s = scripted(10)
    const cancel = new AbortController()
    cancel.abort()
    const request: DrainDeps['request'] = async (method, route, body) =>
      method === 'DELETE' ? null : s.drain.request(method, route, body)
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'stop', waitMs: 60_000, signal: cancel.signal },
      { drain: { ...s.drain, request }, stop: s.stop },
    )
    expect(result.stop).toBeNull()
    expect(result.released).toBe(false)
  })

  it('releases its hold when the stop finds no server, in case one is still up', async () => {
    const s = scripted(0)
    const result = await stopAfterAgentRuns(
      PORT,
      { command: 'stop', waitMs: 60_000 },
      { drain: s.drain, stop: { ...s.stop, isClawboo: async () => false } },
    )
    expect(result.stop).toMatchObject({ status: 'not-running' })
    expect(result.released).toBe(true)
    expect(s.order.at(-1)).toBe(`DELETE /api/system/hold/clawboo-stop-${process.pid}`)
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

  it('asks again with the token after the access gate refuses, keeping the JSON body', async () => {
    const TOKEN = 'drain-test-token'
    const home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-drain-gate-'))
    const seen: { cookie?: string; type?: string; body: string }[] = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seen.push({ cookie: req.headers.cookie, type: req.headers['content-type'], body })
        res.setHeader('Content-Type', 'application/json')
        if (req.headers.cookie !== `clawboo_access=${TOKEN}`) {
          res.statusCode = 401
          res.end(
            JSON.stringify({ error: 'Clawboo access token required.', gate: 'clawboo-access' }),
          )
          return
        }
        res.end(
          JSON.stringify({
            held: true,
            holds: [{ owner: 'clawboo-stop-8' }],
            backgroundWork: 'none',
            runs: { running: 0, queued: 0, limit: 8 },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    // The token goes only to the port the server recorded.
    vi.stubEnv('HOST', '')
    vi.stubEnv('CLAWBOO_HOME', home)
    vi.stubEnv('STUDIO_ACCESS_TOKEN', TOKEN)
    writeFileSync(path.join(home, 'api-port.txt'), String(port))
    try {
      const outcome = await drainDashboard(port, {
        owner: 'clawboo-stop-8',
        reason: 'stop',
        waitMs: 1_000,
      })
      expect(outcome).toEqual({ status: 'idle' })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
    const body = JSON.stringify({ owner: 'clawboo-stop-8', ttlSeconds: 60, reason: 'stop' })
    expect(seen).toEqual([
      { cookie: undefined, type: 'application/json', body },
      { cookie: `clawboo_access=${TOKEN}`, type: 'application/json', body },
    ])
  })
})
