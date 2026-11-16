// Who may watch and take over an agent's screen under the verified person check
// and the take-over claim, both ways in (the dashboard and a link).
//
// Verified: every screen route needs a person a verified token names, a link as
// well as the link; a view is bound to the person who opened it; a stream ends
// after a few minutes so the page asks again with a fresh signed request.
// The claim: a take over and every batch of input need a sign-in proxy token
// whose `control` claim names the agent; a batch without one hands the screen
// back to the agent. With neither switch on, nothing changes.

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The display manager, driven by the test: agent a1 has a display of its own,
// so it can be taken over.
const displayState = vi.hoisted(() => ({ displays: new Map<string, unknown>() }))
vi.mock('../../lib/desktop/displays', () => ({
  displayFor: (agentId: string) => displayState.displays.get(agentId) ?? null,
  onDisplayChange: () => () => undefined,
  displayHolders: () => [],
  displayProblem: () => null,
  displaySupport: () => ({ ok: false, code: 'not-linux', reason: 'test' }),
  stopDisplayNow: () => undefined,
}))
vi.mock('../../lib/desktop/browserFrames', () => ({ captureAgentBrowserFrame: async () => null }))
vi.mock('../../lib/desktop/png', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/desktop/png')>()
  return {
    ...real,
    encodeRegionPngAsync: async (...args: Parameters<typeof real.encodeRegionPng>) =>
      real.encodeRegionPng(...args),
  }
})

const { getDb, resetDb } = await import('../../lib/db')
const { isPersonInControl, resetControlForTests, controllerOf } =
  await import('../../lib/desktop/control')
const { LINK_HEADER, resetLinksForTests } = await import('../../lib/desktop/links')
const { resetLiveViewForTests, viewerCount } = await import('../../lib/desktop/liveView')
const { resetPersonCheckForTests, setControlClaimMode, setPersonCheckMode } =
  await import('../../lib/personCheck')
const {
  VERIFIED_STREAM_MS,
  computerControlPOST,
  computerInputPOST,
  computerLinkControlPOST,
  computerLinkInfoGET,
  computerLinkInputPOST,
  computerLinkLiveGET,
  computerLinksPOST,
  computerLiveGET,
  computerStatusGET,
} = await import('../computer')
const { agentScreenshotCapturePOST, agentScreenshotGET } = await import('../agents')
const { putScreenshot, resetScreenshots } = await import('../../lib/screenshotBus')

class FakeRfb extends EventEmitter {
  width = 4
  height = 2
  fb = Buffer.alloc(4 * 2 * 4, 0x7f)
  isClosed = false
  pointers: [number, number, number][] = []
  keys: [number, boolean][] = []
  requestUpdate() {}
  pointer(x: number, y: number, b: number) {
    this.pointers.push([x, y, b])
  }
  key(s: number, d: boolean) {
    this.keys.push([s, d])
  }
}

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const ADA = { id: 'user-42', name: 'Ada', role: null }
const BOB = { id: 'user-7', name: 'Bob', role: null }
type Who = { person?: typeof ADA | null; claim?: string | null; service?: boolean }

function mockRes() {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
    setHeader() {},
  } as unknown as Response
  return { res, status: () => code, body: () => payload as Record<string, unknown> }
}

/** Every stream a test opened, so teardown can close them: a live stream's
 *  heartbeat and renewal timers stop only on its 'close'. */
const streams: EventEmitter[] = []

/** A response a live view can stream into. `gone`: its connection went before
 *  the route ran, so it is destroyed and never emits 'close' again. */
function streamRes(opts: { gone?: boolean } = {}) {
  const em = new EventEmitter()
  streams.push(em)
  const chunks: string[] = []
  let status = 0
  let ended = false
  const res = Object.assign(em, {
    destroyed: opts.gone === true,
    setHeader() {},
    writeHead(s: number) {
      status = s
    },
    flushHeaders() {},
    write(c: string) {
      chunks.push(c)
      return true
    },
    end() {
      ended = true
      if (!opts.gone) em.emit('close')
    },
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      chunks.push(JSON.stringify(b))
      return this
    },
  }) as unknown as Response
  return {
    res,
    status: () => status,
    text: () => chunks.join(''),
    ended: () => ended,
    viewerId: () => /"viewerId":"([^"]+)"/.exec(chunks.join(''))?.[1] ?? '',
  }
}

function req(
  over: {
    params?: Record<string, string>
    body?: unknown
    hdrs?: Record<string, string>
  } & Who = {},
): Request {
  const headers: Record<string, string> = { ...DASHBOARD, ...(over.hdrs ?? {}) }
  const r = Object.assign(new EventEmitter(), {
    params: over.params ?? {},
    query: {},
    body: over.body ?? {},
    method: 'POST',
    path: '/api/x',
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    person: over.service ? null : (over.person ?? null),
    service: over.service ? ADA : null,
    personVia: over.person && !over.service ? 'proxy' : undefined,
    controlClaim: over.claim ?? null,
  })
  return r as unknown as Request
}

const A1 = { agentId: 'a1' }

/** Open a dashboard live view of a1 as `who`, and return its stream and id. */
function watch(who: Who = {}) {
  const s = streamRes()
  computerLiveGET(req({ params: A1, ...who }), s.res)
  return s
}

function take(viewerId: string, who: Who = {}) {
  const r = mockRes()
  computerControlPOST(req({ params: A1, body: { viewerId, action: 'take' }, ...who }), r.res)
  return r
}

function release(viewerId: string, who: Who = {}) {
  const r = mockRes()
  computerControlPOST(req({ params: A1, body: { viewerId, action: 'release' }, ...who }), r.res)
  return r
}

function type(viewerId: string, who: Who = {}) {
  const r = mockRes()
  computerInputPOST(
    req({ params: A1, body: { viewerId, events: [{ t: 'k', s: 97, d: true }] }, ...who }),
    r.res,
  )
  return r
}

let home: string
let prevHome: string | undefined
let prevAgentUser: string | undefined
let rfb: FakeRfb

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-computer-person-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  prevHome = process.env['HOME']
  prevAgentUser = process.env['CLAWBOO_AGENT_USER']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  const now = Date.now()
  for (const id of ['a1', 'a2']) {
    getDb()
      .insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: 'native',
        sourceAgentId: id,
        identityJson: JSON.stringify({ name: id }),
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
  rfb = new FakeRfb()
  displayState.displays.clear()
  displayState.displays.set('a1', { agentId: 'a1', width: 4, height: 2, rfb })
  resetLinksForTests()
  resetControlForTests()
  resetLiveViewForTests()
  resetPersonCheckForTests()
})

afterEach(async () => {
  // Before the clock or the database goes: a heartbeat left running would read
  // the database from a later test, or from no sandbox at all.
  for (const s of streams.splice(0)) s.emit('close')
  vi.useRealTimers()
  resetLiveViewForTests()
  resetControlForTests()
  resetPersonCheckForTests()
  resetScreenshots()
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevAgentUser === undefined) delete process.env['CLAWBOO_AGENT_USER']
  else process.env['CLAWBOO_AGENT_USER'] = prevAgentUser
  delete process.env['CLAWBOO_HOME']
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('page mode, no claim: as before', () => {
  it('the page watches, takes over and types with no token', () => {
    const s = watch()
    expect(s.status()).toBe(200)
    const id = s.viewerId()
    expect(take(id).status()).toBe(200)
    expect(type(id).status()).toBe(200)
    expect(rfb.keys).toEqual([[97, true]])
  })

  it('a stream does not end by itself', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const s = watch()
    vi.advanceTimersByTime(VERIFIED_STREAM_MS + 60_000)
    expect(s.text()).not.toContain('event: renew')
    expect(s.ended()).toBe(false)
  })
})

describe('verified: every screen route needs a verified person', () => {
  beforeEach(() => setPersonCheckMode('verified'))

  it('refuses the page without a token on state, live, take, release and input', () => {
    const state = mockRes()
    computerStatusGET(req({ params: A1 }), state.res)
    expect([state.status(), state.body()['error']]).toEqual([403, 'person_only'])

    const s = streamRes()
    computerLiveGET(req({ params: A1 }), s.res)
    expect(s.status()).toBe(403)
    expect(s.text()).toContain('person_only')

    // A view Ada opened, which the page alone may not drive or hand back.
    const id = watch({ person: ADA }).viewerId()
    expect(take(id).status()).toBe(403)
    expect(take(id, { person: ADA }).status()).toBe(200)
    expect(type(id).body()['error']).toBe('person_only')
    expect(release(id).body()['error']).toBe('person_only')
    expect(isPersonInControl('a1')).toBe(true)
    expect(rfb.keys).toEqual([])
  })

  it('lets a verified person watch, take over, type and hand back', () => {
    const state = mockRes()
    computerStatusGET(req({ params: A1, person: ADA }), state.res)
    expect(state.status()).toBe(200)
    const id = watch({ person: ADA }).viewerId()
    expect(take(id, { person: ADA }).status()).toBe(200)
    expect(type(id, { person: ADA }).status()).toBe(200)
    expect(rfb.keys).toEqual([[97, true]])
    expect(release(id, { person: ADA }).status()).toBe(200)
    expect(isPersonInControl('a1')).toBe(false)
  })

  it("refuses the page the agent's browser screenshots, which show its screen too", async () => {
    putScreenshot('a1', { data: 'AA==', mimeType: 'image/png', toolName: 'browser_screenshot' })
    const shot = mockRes()
    agentScreenshotGET(req({ params: A1 }), shot.res)
    expect([shot.status(), shot.body()['error']]).toEqual([403, 'person_only'])
    const meta = mockRes()
    agentScreenshotGET(
      Object.assign(req({ params: A1 }), { query: { meta: '1' } }) as unknown as Request,
      meta.res,
    )
    expect(meta.status()).toBe(403)
    const capture = mockRes()
    await agentScreenshotCapturePOST(req({ params: A1 }), capture.res)
    expect([capture.status(), capture.body()['error']]).toEqual([403, 'person_only'])

    // A verified person gets them as before.
    const seen = mockRes()
    agentScreenshotGET(
      Object.assign(req({ params: A1, person: ADA }), {
        query: { meta: '1' },
      }) as unknown as Request,
      seen.res,
    )
    expect(seen.status()).toBe(200)
    const tried = mockRes()
    await agentScreenshotCapturePOST(req({ params: A1, person: ADA }), tried.res)
    // No browser open in this test: the capture itself answers, not the check.
    expect(tried.status()).toBe(409)
  })

  it('never lets a service token watch or take over', () => {
    const s = streamRes()
    computerLiveGET(req({ params: A1, service: true }), s.res)
    expect(s.status()).toBe(403)
  })

  it('binds a view to its person: another person cannot take it over, type into it or resume it', () => {
    const id = watch({ person: ADA }).viewerId()
    expect(take(id, { person: BOB }).status()).toBe(404)
    expect(take(id, { person: ADA }).status()).toBe(200)
    expect(type(id, { person: BOB }).status()).toBe(404)
    // Bob naming Ada's view on a new stream gets a view of his own, not her control.
    const bob = streamRes()
    computerLiveGET(req({ params: A1, person: BOB, hdrs: { 'x-clawboo-viewer': id } }), bob.res)
    expect(bob.viewerId()).not.toBe(id)
    expect(controllerOf('a1')?.viewerId).toBe(id)
    expect(rfb.keys).toEqual([])
  })

  it('ends a view stream after a few minutes, and the reconnect keeps control', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const s = watch({ person: ADA })
    const id = s.viewerId()
    expect(take(id, { person: ADA }).status()).toBe(200)
    vi.advanceTimersByTime(VERIFIED_STREAM_MS - 1_000)
    expect(s.ended()).toBe(false)
    vi.advanceTimersByTime(2_000)
    expect(s.text()).toContain('event: renew')
    expect(s.ended()).toBe(true)
    // The page comes back at once with a fresh signed request, naming its view.
    const again = streamRes()
    computerLiveGET(req({ params: A1, person: ADA, hdrs: { 'x-clawboo-viewer': id } }), again.res)
    expect(again.viewerId()).toBe(id)
    expect(type(id, { person: ADA }).status()).toBe(200)
  })

  it('a renewal lets go of a key the person held, rather than leave it down', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const id = watch({ person: ADA }).viewerId()
    expect(take(id, { person: ADA }).status()).toBe(200)
    expect(type(id, { person: ADA }).status()).toBe(200)
    vi.advanceTimersByTime(VERIFIED_STREAM_MS + 1_000)
    const again = streamRes()
    computerLiveGET(req({ params: A1, person: ADA, hdrs: { 'x-clawboo-viewer': id } }), again.res)
    expect(again.viewerId()).toBe(id)
    expect(release(id, { person: ADA }).status()).toBe(200)
    expect(rfb.keys).toEqual([
      [97, true],
      [97, false],
    ])
  })

  it('opens no view for a connection that went before the route ran', () => {
    // The lane checks the token asynchronously, so a client that resets at once is
    // gone by the time the route runs, and its 'close' has already fired.
    for (let i = 0; i < 10; i++) {
      const gone = streamRes({ gone: true })
      computerLiveGET(req({ params: A1, person: ADA }), gone.res)
    }
    expect(viewerCount('a1')).toBe(0)
    // So a verified person still finds a place.
    expect(watch({ person: ADA }).text()).toContain('event: hello')
  })

  it('a renewal frees its place even when the connection never says it closed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    const s = streamRes({ gone: false })
    computerLiveGET(req({ params: A1, person: ADA }), s.res)
    expect(viewerCount('a1')).toBe(1)
    // From here on the connection is dead: ending it emits nothing.
    ;(s.res as unknown as { end: () => void }).end = () => undefined
    vi.advanceTimersByTime(VERIFIED_STREAM_MS + 1_000)
    expect(s.text()).toContain('event: renew')
    expect(viewerCount('a1')).toBe(0)
  })

  it('a link needs a verified person as well as the link, for info, live, take and input', () => {
    process.env['CLAWBOO_AGENT_USER'] = 'clawboo-agent'
    const made = mockRes()
    computerLinksPOST(req({ params: A1, body: { kind: 'control' }, person: ADA }), made.res)
    expect(made.status()).toBe(201)
    const token = made.body()['token'] as string
    const link = { [LINK_HEADER]: token }

    const info = mockRes()
    computerLinkInfoGET(req({ hdrs: link }), info.res)
    expect(info.status()).toBe(403)
    const infoOk = mockRes()
    computerLinkInfoGET(req({ hdrs: link, person: BOB }), infoOk.res)
    expect(infoOk.status()).toBe(200)

    const refused = streamRes()
    computerLinkLiveGET(req({ hdrs: link }), refused.res)
    expect(refused.status()).toBe(403)

    const s = streamRes()
    computerLinkLiveGET(req({ hdrs: link, person: BOB }), s.res)
    const id = s.viewerId()
    const takeAs = (who: Who) => {
      const r = mockRes()
      computerLinkControlPOST(
        req({ hdrs: link, body: { viewerId: id, action: 'take' }, ...who }),
        r.res,
      )
      return r
    }
    const typeAs = (who: Who) => {
      const r = mockRes()
      computerLinkInputPOST(
        req({ hdrs: link, body: { viewerId: id, events: [{ t: 'k', s: 98, d: true }] }, ...who }),
        r.res,
      )
      return r
    }
    expect(takeAs({}).status()).toBe(403)
    expect(takeAs({ person: ADA }).status()).toBe(404)
    expect(takeAs({ person: BOB }).status()).toBe(200)
    expect(typeAs({}).status()).toBe(403)
    expect(typeAs({ person: BOB }).status()).toBe(200)
    expect(rfb.keys).toEqual([[98, true]])
  })
})

describe('the take-over claim', () => {
  beforeEach(() => setControlClaimMode('required'))

  it("refuses a take over without a claim, or with another agent's", () => {
    const id = watch({ person: ADA }).viewerId()
    expect(take(id).body()['error']).toBe('control_claim')
    expect(take(id, { person: ADA }).body()['error']).toBe('control_claim')
    expect(take(id, { person: ADA, claim: 'a2' }).body()['error']).toBe('control_claim')
    expect(isPersonInControl('a1')).toBe(false)
    expect(take(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
    expect(isPersonInControl('a1')).toBe(true)
  })

  it('checks every batch of input, and a batch without it hands the screen back', () => {
    const id = watch({ person: ADA }).viewerId()
    expect(take(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
    expect(type(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
    const refused = type(id, { person: ADA })
    expect([refused.status(), refused.body()['error']]).toEqual([403, 'control_claim'])
    // The agent has its screen back: its own tools stop waiting, and the key the
    // person held is let go rather than left down.
    expect(isPersonInControl('a1')).toBe(false)
    expect(rfb.keys).toEqual([
      [97, true],
      [97, false],
    ])
  })

  it("a refused batch from someone else leaves the holder's control alone", () => {
    const id = watch({ person: ADA }).viewerId()
    expect(take(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
    expect(type(id, { person: BOB }).body()['error']).toBe('control_claim')
    expect(type(id).body()['error']).toBe('control_claim')
    expect(controllerOf('a1')?.viewerId).toBe(id)
  })

  it('binds control to the person who took it, even in page mode', () => {
    const id = watch().viewerId()
    expect(take(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
    // Bob holds a claim for a1 too, but the control is Ada's.
    expect(type(id, { person: BOB, claim: 'a1' }).status()).toBe(403)
    expect(type(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
    // Handing back needs no claim, only the holder.
    expect(release(id, { person: BOB }).status()).toBe(200)
    expect(isPersonInControl('a1')).toBe(true)
    expect(release(id, { person: ADA }).status()).toBe(200)
    expect(isPersonInControl('a1')).toBe(false)
  })

  it("a request that names a held view's id cannot end it, nor inherit its control", () => {
    const ada = watch({ person: ADA })
    const id = ada.viewerId()
    expect(take(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
    // No token at all, naming Ada's view: the page mode check lets it watch.
    const other = streamRes()
    computerLiveGET(req({ params: A1, hdrs: { 'x-clawboo-viewer': id } }), other.res)
    expect(other.viewerId()).not.toBe(id)
    expect(ada.ended()).toBe(false)
    // Ada still holds control, attached: her next batch goes through at once.
    expect(type(id, { person: ADA, claim: 'a1' }).status()).toBe(200)
  })

  it('never lets a service token take over, even with a claim', () => {
    const id = watch().viewerId()
    expect(take(id, { service: true, claim: 'a1' }).status()).toBe(403)
    expect(isPersonInControl('a1')).toBe(false)
  })

  it('watching needs no claim', () => {
    const state = mockRes()
    computerStatusGET(req({ params: A1, person: ADA }), state.res)
    expect(state.status()).toBe(200)
    expect(state.body()['controlClaim']).toEqual({ required: true, granted: false })
    const granted = mockRes()
    computerStatusGET(req({ params: A1, person: ADA, claim: 'a1' }), granted.res)
    expect(granted.body()['controlClaim']).toEqual({ required: true, granted: true })
    expect(watch().status()).toBe(200)
  })

  it("on a link: the claim must name the link's agent", () => {
    process.env['CLAWBOO_AGENT_USER'] = 'clawboo-agent'
    const made = mockRes()
    computerLinksPOST(req({ params: A1, body: { kind: 'control' } }), made.res)
    const link = { [LINK_HEADER]: made.body()['token'] as string }
    const s = streamRes()
    computerLinkLiveGET(req({ hdrs: link }), s.res)
    const id = s.viewerId()
    const takeAs = (who: Who) => {
      const r = mockRes()
      computerLinkControlPOST(
        req({ hdrs: link, body: { viewerId: id, action: 'take' }, ...who }),
        r.res,
      )
      return r
    }
    expect(takeAs({ person: ADA, claim: 'a2' }).body()['error']).toBe('control_claim')
    expect(takeAs({ person: ADA, claim: 'a1' }).status()).toBe(200)
    const typed = mockRes()
    computerLinkInputPOST(
      req({
        hdrs: link,
        body: { viewerId: id, events: [{ t: 'k', s: 99, d: true }] },
        person: ADA,
      }),
      typed.res,
    )
    expect(typed.body()['error']).toBe('control_claim')
    expect(isPersonInControl('a1')).toBe(false)
  })
})
