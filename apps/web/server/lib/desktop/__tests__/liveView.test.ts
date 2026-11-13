import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The display manager is replaced by a switchboard the test drives: which agent
// has a display, and the "display started/stopped" signal.
const displayState = vi.hoisted(() => ({
  displays: new Map<string, unknown>(),
  listeners: new Set<(agentId: string, d: unknown) => void>(),
}))
vi.mock('../displays', () => ({
  displayFor: (agentId: string) => displayState.displays.get(agentId) ?? null,
  onDisplayChange: (fn: (agentId: string, d: unknown) => void) => {
    displayState.listeners.add(fn)
    return () => displayState.listeners.delete(fn)
  },
}))
vi.mock('../browserFrames', () => ({ captureAgentBrowserFrame: async () => null }))

const { resetControlForTests, isPersonInControl } = await import('../control')
const { mintLink, resetLinksForTests, revokeLink } = await import('../links')
const live = await import('../liveView')

class FakeRfb extends EventEmitter {
  width = 4
  height = 2
  fb = Buffer.alloc(4 * 2 * 4, 0x7f)
  isClosed = false
  requests: boolean[] = []
  pointers: [number, number, number][] = []
  keys: [number, boolean][] = []
  requestUpdate(incremental: boolean) {
    this.requests.push(incremental)
  }
  /** One update from the display, as RfbClient reports it. */
  update(rects: { x: number; y: number; w: number; h: number }[]) {
    this.emit('update', rects)
    this.emit('frame')
  }
  /** A size change alone: no pixels, then the end of the update. */
  resize(w: number, h: number) {
    this.width = w
    this.height = h
    this.fb = Buffer.alloc(w * h * 4)
    this.emit('resize', w, h)
    this.emit('frame')
  }
  pointer(x: number, y: number, b: number) {
    this.pointers.push([x, y, b])
  }
  key(s: number, d: boolean) {
    this.keys.push([s, d])
  }
}

function fakeDisplay(agentId: string) {
  const rfb = new FakeRfb()
  const display = { agentId, width: rfb.width, height: rfb.height, rfb }
  displayState.displays.set(agentId, display)
  return { rfb, display }
}

interface Sent {
  event: string
  data: Record<string, unknown>
}

function sink(opts: { full?: boolean } = {}) {
  const sent: Sent[] = []
  let drain: (() => void) | null = null
  let ended = false
  return {
    sent,
    get ended() {
      return ended
    },
    drain: () => {
      const d = drain
      drain = null
      d?.()
    },
    of: (event: string) => sent.filter((s) => s.event === event),
    sink: {
      send(event: string, data: unknown) {
        sent.push({ event, data: data as Record<string, unknown> })
        return !opts.full
      },
      onDrain(cb: () => void) {
        drain = cb
      },
      end() {
        ended = true
      },
    },
  }
}

/** Let compression on the thread pool finish: setImmediate is not faked. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

/** Let pending promise callbacks run (timers are fake, so no setTimeout here). */
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
  })
  displayState.displays.clear()
  displayState.listeners.clear()
  resetControlForTests()
  resetLinksForTests()
  live.resetLiveViewForTests()
  live.setBrowserCaptureForTests(async () => null)
})
afterEach(() => {
  live.resetLiveViewForTests()
  live.setBrowserCaptureForTests(null)
  vi.useRealTimers()
})

describe('live view of an agent display', () => {
  it('asks for the whole screen, sends it as PNG, then only what changed', async () => {
    const { rfb } = fakeDisplay('a')
    const w = sink()
    const { viewerId } = live.openViewer('a', { kind: 'dashboard' }, w.sink)
    expect(w.of('hello')[0]?.data['viewerId']).toBe(viewerId)
    expect(w.of('source')[0]?.data).toMatchObject({ source: 'display', width: 4, height: 2 })
    expect(rfb.requests).toEqual([false])

    rfb.update([{ x: 0, y: 0, w: 4, h: 2 }])
    await settle()
    const first = w.of('rects')[0]?.data['rects'] as { x: number; w: number; png: string }[]
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ x: 0, y: 0, w: 4, h: 2 })
    expect(Buffer.from(first[0]!.png, 'base64').subarray(1, 4).toString()).toBe('PNG')

    // The next request is incremental, after the update interval.
    vi.advanceTimersByTime(100)
    expect(rfb.requests).toEqual([false, true])
    rfb.update([{ x: 1, y: 1, w: 1, h: 1 }])
    vi.advanceTimersByTime(100)
    await settle()
    const second = w.of('rects')[1]?.data['rects'] as { x: number; y: number; w: number }[]
    expect(second).toEqual([expect.objectContaining({ x: 1, y: 1, w: 1, h: 1 })])
  })

  it('keeps asking after a size change, and sends the whole new screen', async () => {
    const { rfb } = fakeDisplay('a')
    const w = sink()
    live.openViewer('a', { kind: 'dashboard' }, w.sink)
    rfb.update([{ x: 0, y: 0, w: 4, h: 2 }])
    vi.advanceTimersByTime(100)
    expect(rfb.requests).toEqual([false, true])
    rfb.resize(6, 3)
    vi.advanceTimersByTime(100)
    expect(rfb.requests).toEqual([false, true, true])
    expect(w.of('source').at(-1)?.data).toMatchObject({ width: 6, height: 3 })
    // The picture of the old screen in flight lands first; the new one follows.
    await settle()
    vi.advanceTimersByTime(100)
    await settle()
    const last = w.of('rects').at(-1)?.data as { width: number; rects: { w: number; h: number }[] }
    expect(last.width).toBe(6)
    expect(last.rects).toEqual([expect.objectContaining({ w: 6, h: 3 })])
  })

  it('lets go of every key and button held when control changes hands', () => {
    const { rfb } = fakeDisplay('a')
    const a = live.openViewer('a', { kind: 'dashboard' }, sink().sink)
    const b = live.openViewer('a', { kind: 'dashboard' }, sink().sink)
    live.setControl('a', a.viewerId, { kind: 'dashboard' }, 'take')
    live.sendInput('a', a.viewerId, { kind: 'dashboard' }, [
      { t: 'k', s: 0xffe1, d: true },
      { t: 'p', x: 2, y: 1, b: 1 },
    ])
    rfb.keys.length = 0
    rfb.pointers.length = 0
    live.setControl('a', b.viewerId, { kind: 'dashboard' }, 'take')
    expect(rfb.keys).toEqual([[0xffe1, false]])
    expect(rfb.pointers).toEqual([[2, 1, 0]])
  })

  it('lets a page that comes back replace its own stream that still looks open', () => {
    fakeDisplay('a')
    const old = sink()
    const first = live.openViewer('a', { kind: 'dashboard' }, old.sink)
    live.setControl('a', first.viewerId, { kind: 'dashboard' }, 'take')
    const again = live.openViewer('a', { kind: 'dashboard' }, sink().sink, first.viewerId)
    expect(old.ended).toBe(true)
    expect(again.viewerId).toBe(first.viewerId)
    expect(live.viewerCount('a')).toBe(1)
    expect(live.sendInput('a', again.viewerId, { kind: 'dashboard' }, [])).toEqual({
      ok: true,
      state: 'you',
    })
  })

  it('hands control back when asked just after the view closed', () => {
    fakeDisplay('a')
    const v = live.openViewer('a', { kind: 'dashboard' }, sink().sink)
    live.setControl('a', v.viewerId, { kind: 'dashboard' }, 'take')
    v.close()
    expect(isPersonInControl('a')).toBe(true)
    // Not through some other way in.
    const link = mintLink('a', 'control').link
    live.setControl(
      'a',
      v.viewerId,
      { kind: 'link', linkId: link.id, linkKind: 'control' },
      'release',
    )
    expect(isPersonInControl('a')).toBe(true)
    live.setControl('a', v.viewerId, { kind: 'dashboard' }, 'release')
    expect(isPersonInControl('a')).toBe(false)
  })

  it('holds a backed-up watcher, merges what it missed, and sends it on drain', async () => {
    const { rfb } = fakeDisplay('a')
    const w = sink({ full: true })
    live.openViewer('a', { kind: 'dashboard' }, w.sink)
    rfb.update([{ x: 0, y: 0, w: 4, h: 2 }])
    await settle()
    expect(w.of('rects')).toHaveLength(1) // sent, and the connection is now backed up
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(100)
      rfb.update([{ x: i % 4, y: 0, w: 1, h: 1 }])
    }
    await settle()
    expect(w.of('rects')).toHaveLength(1)
    w.drain()
    vi.advanceTimersByTime(100)
    await settle()
    const merged = w.of('rects')[1]?.data['rects'] as unknown[]
    expect(w.of('rects')).toHaveLength(2)
    expect(merged).toHaveLength(1) // twenty regions, one picture of their box
  })

  it('lets a dashboard watcher take over and type, and refuses everyone else input', () => {
    const { rfb } = fakeDisplay('a')
    const a = sink()
    const b = sink()
    const va = live.openViewer('a', { kind: 'dashboard' }, a.sink).viewerId
    const vb = live.openViewer('a', { kind: 'dashboard' }, b.sink).viewerId

    expect(
      live.sendInput('a', va, { kind: 'dashboard' }, [{ t: 'k', s: 0x61, d: true }]),
    ).toMatchObject({
      ok: false,
      status: 409,
    })
    expect(live.setControl('a', va, { kind: 'dashboard' }, 'take')).toEqual({
      ok: true,
      state: 'you',
    })
    expect(isPersonInControl('a')).toBe(true)
    expect(a.of('control').at(-1)?.data).toMatchObject({ state: 'you' })
    expect(b.of('control').at(-1)?.data).toMatchObject({ state: 'other' })

    expect(
      live.sendInput('a', va, { kind: 'dashboard' }, [
        { t: 'p', x: 3, y: 1, b: 1 },
        { t: 'k', s: 0x61, d: true },
      ]),
    ).toEqual({ ok: true, state: 'you' })
    expect(rfb.pointers).toEqual([[3, 1, 1]])
    expect(rfb.keys).toEqual([[0x61, true]])
    expect(
      live.sendInput('a', vb, { kind: 'dashboard' }, [{ t: 'k', s: 0x62, d: true }]),
    ).toMatchObject({
      ok: false,
    })
    expect(rfb.keys).toHaveLength(1)
  })

  it('never lets a view link take over, but lets a control link', () => {
    fakeDisplay('a')
    const view = mintLink('a', 'view').link
    const ctl = mintLink('a', 'control').link
    const v1 = live.openViewer(
      'a',
      { kind: 'link', linkId: view.id, linkKind: 'view' },
      sink().sink,
    )
    const v2 = live.openViewer(
      'a',
      { kind: 'link', linkId: ctl.id, linkKind: 'control' },
      sink().sink,
    )
    expect(
      live.setControl(
        'a',
        v1.viewerId,
        { kind: 'link', linkId: view.id, linkKind: 'view' },
        'take',
      ),
    ).toMatchObject({ ok: false, status: 403 })
    // A viewer id named through a different way in is not that viewer.
    expect(live.setControl('a', v2.viewerId, { kind: 'dashboard' }, 'take')).toMatchObject({
      ok: false,
      status: 404,
    })
    expect(
      live.setControl(
        'a',
        v2.viewerId,
        { kind: 'link', linkId: ctl.id, linkKind: 'control' },
        'take',
      ),
    ).toEqual({ ok: true, state: 'you' })
  })

  it('closes every view open through a link the moment it is revoked, and hands control back', () => {
    fakeDisplay('a')
    const ctl = mintLink('a', 'control').link
    const via = { kind: 'link' as const, linkId: ctl.id, linkKind: 'control' as const }
    const w = sink()
    const { viewerId } = live.openViewer('a', via, w.sink)
    live.setControl('a', viewerId, via, 'take')
    expect(isPersonInControl('a')).toBe(true)
    revokeLink('a', ctl.id)
    expect(w.ended).toBe(true)
    expect(w.of('end')[0]?.data['reason']).toMatch(/revoked/)
    expect(isPersonInControl('a')).toBe(false)
    expect(live.viewerCount('a')).toBe(0)
  })

  it('keeps control through a reconnect that comes back the same way', () => {
    fakeDisplay('a')
    const first = live.openViewer('a', { kind: 'dashboard' }, sink().sink)
    live.setControl('a', first.viewerId, { kind: 'dashboard' }, 'take')
    first.close()
    const again = live.openViewer('a', { kind: 'dashboard' }, sink().sink, first.viewerId)
    expect(again.viewerId).toBe(first.viewerId)
    expect(live.sendInput('a', again.viewerId, { kind: 'dashboard' }, [])).toEqual({
      ok: true,
      state: 'you',
    })
  })

  it('refuses take over where the agent has no display', () => {
    const w = sink()
    const { viewerId } = live.openViewer('mac', { kind: 'dashboard' }, w.sink)
    expect(w.of('source')[0]?.data).toMatchObject({ source: 'browser' })
    expect(w.of('control')[0]?.data).toMatchObject({ canControl: false })
    expect(live.setControl('mac', viewerId, { kind: 'dashboard' }, 'take')).toMatchObject({
      ok: false,
      status: 409,
    })
  })
})

describe('places for watchers', () => {
  it('lets one link open two views at most, and keeps places for the dashboard', () => {
    fakeDisplay('a')
    const links = [
      mintLink('a', 'view').link,
      mintLink('a', 'view').link,
      mintLink('a', 'view').link,
    ]
    const via = (i: number) => ({
      kind: 'link' as const,
      linkId: links[i]!.id,
      linkKind: 'view' as const,
    })
    live.openViewer('a', via(0), sink().sink)
    live.openViewer('a', via(0), sink().sink)
    expect(() => live.openViewer('a', via(0), sink().sink)).toThrow(live.LiveViewLimitError)
    live.openViewer('a', via(1), sink().sink)
    live.openViewer('a', via(1), sink().sink)
    live.openViewer('a', via(2), sink().sink)
    live.openViewer('a', via(2), sink().sink)
    // Six link views: the last two places on this agent are the dashboard's.
    const fourth = mintLink('a', 'view').link
    expect(() =>
      live.openViewer('a', { kind: 'link', linkId: fourth.id, linkKind: 'view' }, sink().sink),
    ).toThrow(live.LiveViewLimitError)
    expect(() => live.openViewer('a', { kind: 'dashboard' }, sink().sink)).not.toThrow()
    expect(() => live.openViewer('a', { kind: 'dashboard' }, sink().sink)).not.toThrow()
    expect(() => live.openViewer('a', { kind: 'dashboard' }, sink().sink)).toThrow(
      live.LiveViewLimitError,
    )
  })
})

describe('live view of an agent browser', () => {
  it('photographs while watched, sends only a changed picture, and stops when nobody watches', async () => {
    const frames = ['AAAA', 'AAAA', 'BBBB']
    const capture = vi.fn(async () => {
      const data = frames.shift()
      return data ? { data, mimeType: 'image/jpeg', toolName: 'browser_take_screenshot' } : null
    })
    live.setBrowserCaptureForTests(capture)
    const w = sink()
    const v = live.openViewer('mac', { kind: 'dashboard' }, w.sink)
    await tick()
    vi.advanceTimersByTime(live.BROWSER_FRAME_INTERVAL_MS)
    await tick()
    vi.advanceTimersByTime(live.BROWSER_FRAME_INTERVAL_MS)
    await tick()
    expect(w.of('image').map((s) => s.data['data'])).toEqual(['AAAA', 'BBBB'])
    vi.advanceTimersByTime(live.BROWSER_FRAME_INTERVAL_MS)
    await tick()
    expect(w.of('idle')).toHaveLength(1)
    v.close()
    const calls = capture.mock.calls.length
    vi.advanceTimersByTime(10 * live.BROWSER_FRAME_INTERVAL_MS)
    await tick()
    expect(capture.mock.calls.length).toBe(calls)
  })

  it('switches to the display when one starts', () => {
    const w = sink()
    live.openViewer('a', { kind: 'dashboard' }, w.sink)
    const { display, rfb } = fakeDisplay('a')
    for (const fn of displayState.listeners) fn('a', display)
    expect(w.of('source').at(-1)?.data).toMatchObject({ source: 'display' })
    expect(rfb.requests).toEqual([false])
  })
})

describe('parseInputEvents', () => {
  it('takes pointer and key events and refuses anything malformed', () => {
    expect(
      live.parseInputEvents([
        { t: 'p', x: 1, y: 2, b: 0 },
        { t: 'k', s: 0xff0d, d: false },
      ]),
    ).toEqual([
      { t: 'p', x: 1, y: 2, b: 0 },
      { t: 'k', s: 0xff0d, d: false },
    ])
    expect(live.parseInputEvents([{ t: 'k', s: -1, d: true }])).toBeNull()
    expect(live.parseInputEvents([{ t: 'p', x: 'a', y: 2, b: 0 }])).toBeNull()
    expect(live.parseInputEvents([{ t: 'x' }])).toBeNull()
    expect(live.parseInputEvents('nope')).toBeNull()
    expect(
      live.parseInputEvents(Array.from({ length: 300 }, () => ({ t: 'k', s: 97, d: true }))),
    ).toBeNull()
  })
})
