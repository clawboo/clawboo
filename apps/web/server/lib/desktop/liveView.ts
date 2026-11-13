// The live view: one agent's screen, sent to whoever is watching it.
//
// TWO SOURCES, ONE STREAM. An agent with a display of its own (Linux) is
// watched through the server's VNC connection to that display: what changed is
// sent as PNG pictures of the changed regions, and the person in control types
// and clicks into it. An agent without one (a Mac, a Windows machine) is watched
// through its browser's own screenshot tool, about once a second; that view is
// for watching only.
//
// BACKPRESSURE. Each watcher keeps a list of regions it has not been sent yet.
// A watcher whose connection is backed up is skipped until it drains, and its
// regions merge meanwhile, so a slow phone gets fewer, larger pictures of the
// current screen and never a queue of stale ones. Nothing here is written to
// disk or to the event log: a frame's value is gone in a second.
//
// Watching costs nothing when nobody watches: the display is asked for updates
// only while a watcher is connected, and the browser is photographed only then.

import { createHash, randomUUID } from 'node:crypto'

import { createLogger } from '@clawboo/logger'

import {
  controllerOf,
  holdsControl,
  onControlChange,
  releaseControl,
  releaseControlByLink,
  takeControl,
  viewerDetached,
  viewerReattached,
  type Controller,
} from './control'
import { captureAgentBrowserFrame, type BrowserFrame } from './browserFrames'
import { displayFor, onDisplayChange, type AgentDisplay } from './displays'
import { onLinkEnded, type LinkKind } from './links'
import { encodeRegionPngAsync } from './png'
import type { Rect } from './rfb'

const log = createLogger('live-view')

/** The fewest milliseconds between two pictures sent to one watcher. */
const MIN_SEND_INTERVAL_MS = 100

/** How often a display is asked for what changed while someone watches. */
const UPDATE_INTERVAL_MS = 100

/** How often a browser without a display is photographed while watched. */
export const BROWSER_FRAME_INTERVAL_MS = 1_000

/** More pending regions than this, or more than this share of the screen, go as
 *  one picture of their bounding box. */
const MAX_PENDING_RECTS = 12
const FULL_SCREEN_SHARE = 0.6

/** Watchers per agent, and in all. */
const MAX_VIEWERS_PER_AGENT = 8
const MAX_VIEWERS = 32

/** Watchers one link may have open at once, and the places kept for the
 *  dashboard, so links handed out can never lock the operator out. */
const MAX_VIEWERS_PER_LINK = 2
const DASHBOARD_PLACES_PER_AGENT = 2
const DASHBOARD_PLACES = 8

/** Input events accepted in one batch. */
export const MAX_INPUT_EVENTS = 256

/** Where a watcher came from, which decides what it may do. */
export type ViewerVia = { kind: 'dashboard' } | { kind: 'link'; linkId: string; linkKind: LinkKind }

/** One open connection to a watcher, as the route gives it. */
export interface ViewerSink {
  /** Send one event. False when the connection is backed up. */
  send(event: string, data: unknown): boolean
  /** Called once when a backed-up connection can take more. */
  onDrain(cb: () => void): void
  /** End the connection. */
  end(): void
}

/** What the screen is: an agent's own display, its browser, or nothing yet. */
export type SourceKind = 'display' | 'browser'

interface Viewer {
  id: string
  agentId: string
  via: ViewerVia
  sink: ViewerSink
  pending: Rect[]
  needsFull: boolean
  waitingDrain: boolean
  timer: NodeJS.Timeout | null
  lastSentAt: number
  /** Pictures for this watcher are being compressed. */
  encoding: boolean
  closed: boolean
}

interface Hub {
  agentId: string
  viewers: Set<Viewer>
  display: AgentDisplay | null
  unsubscribeDisplay: (() => void) | null
  updateTimer: NodeJS.Timeout | null
  browserTimer: NodeJS.Timeout | null
  browserBusy: boolean
  lastFrameHash: string | null
  /** What the last browser photograph found: a picture, or nothing open. */
  browserState: 'unknown' | 'showing' | 'none'
  /** Keys and buttons the person in control holds down on the display, so they
   *  can be let go when control changes hands rather than left held. */
  keysDown: Set<number>
  pointer: { x: number; y: number; b: number }
}

const hubs = new Map<string, Hub>()
let totalViewers = 0
let wired = false

export class LiveViewLimitError extends Error {
  constructor() {
    super('Too many people are watching right now. Close another live view and try again.')
    this.name = 'LiveViewLimitError'
  }
}

/** Overridable by tests. */
let captureBrowser: (agentId: string) => Promise<BrowserFrame | null> = (agentId) =>
  captureAgentBrowserFrame(agentId, { live: true })

export function setBrowserCaptureForTests(
  fn: ((agentId: string) => Promise<BrowserFrame | null>) | null,
): void {
  captureBrowser = fn ?? ((agentId) => captureAgentBrowserFrame(agentId, { live: true }))
}

function wire(): void {
  if (wired) return
  wired = true
  onDisplayChange((agentId, display) => {
    const hub = hubs.get(agentId)
    if (hub) attachSource(hub, display)
  })
  onControlChange(({ agentId, controller }) => {
    const hub = hubs.get(agentId)
    if (!hub) return
    letGoOfInput(hub)
    for (const v of hub.viewers) v.sink.send('control', controlStateFor(v, controller))
  })
  onLinkEnded((linkId) => {
    releaseControlByLink(linkId)
    for (const hub of hubs.values()) {
      for (const v of [...hub.viewers]) {
        if (v.via.kind === 'link' && v.via.linkId === linkId) {
          v.sink.send('end', { reason: 'This link was revoked or has expired.' })
          v.sink.end()
          closeViewer(v)
        }
      }
    }
  })
}

/** Release every key and button the last person in control left held, so the
 *  next one (or the agent) does not start with Shift down or a button pressed. */
function letGoOfInput(hub: Hub): void {
  const rfb = hub.display?.rfb
  if (rfb) {
    for (const s of hub.keysDown) rfb.key(s, false)
    if (hub.pointer.b !== 0) rfb.pointer(hub.pointer.x, hub.pointer.y, 0)
  }
  hub.keysDown.clear()
  hub.pointer = { ...hub.pointer, b: 0 }
}

function canControl(v: Viewer): boolean {
  return v.via.kind === 'dashboard' || v.via.linkKind === 'control'
}

function controlStateFor(
  v: Viewer,
  c: Controller | null,
): { state: 'agent' | 'you' | 'other'; canControl: boolean } {
  return {
    state: !c ? 'agent' : c.viewerId === v.id ? 'you' : 'other',
    canControl: canControl(v) && !!hubs.get(v.agentId)?.display,
  }
}

function hubFor(agentId: string): Hub {
  let hub = hubs.get(agentId)
  if (!hub) {
    hub = {
      agentId,
      viewers: new Set(),
      display: null,
      unsubscribeDisplay: null,
      updateTimer: null,
      browserTimer: null,
      browserBusy: false,
      lastFrameHash: null,
      browserState: 'unknown',
      keysDown: new Set(),
      pointer: { x: 0, y: 0, b: 0 },
    }
    hubs.set(agentId, hub)
  }
  return hub
}

function sourceOf(hub: Hub): SourceKind {
  return hub.display ? 'display' : 'browser'
}

function sendSource(hub: Hub, v: Viewer): void {
  v.sink.send('source', {
    source: sourceOf(hub),
    width: hub.display?.rfb.width ?? null,
    height: hub.display?.rfb.height ?? null,
  })
  v.sink.send('control', controlStateFor(v, controllerOf(hub.agentId)))
}

/** Switch a hub to the agent's display, or back to its browser. */
function attachSource(hub: Hub, display: AgentDisplay | null): void {
  if (hub.display === display) return
  hub.unsubscribeDisplay?.()
  hub.unsubscribeDisplay = null
  if (hub.updateTimer) clearTimeout(hub.updateTimer)
  hub.updateTimer = null
  hub.display = display
  if (hub.viewers.size === 0) return
  if (display) {
    stopBrowserPolling(hub)
    subscribeDisplay(hub, display)
  } else {
    startBrowserPolling(hub)
  }
  for (const v of hub.viewers) {
    v.pending = []
    v.needsFull = true
    sendSource(hub, v)
    pump(hub, v)
  }
}

function subscribeDisplay(hub: Hub, display: AgentDisplay): void {
  const rfb = display.rfb
  const onUpdate = (rects: Rect[]) => {
    for (const v of hub.viewers) {
      addPending(v, rects)
      pump(hub, v)
    }
  }
  const onResize = (width: number, height: number) => {
    for (const v of hub.viewers) {
      v.pending = []
      v.needsFull = true
      v.sink.send('source', { source: 'display', width, height })
      pump(hub, v)
    }
  }
  // The next request goes out after EVERY update, including one that only
  // changed the size: the display answers a request once, and nothing else asks.
  const onFrame = () => scheduleUpdate(hub)
  rfb.on('update', onUpdate)
  rfb.on('resize', onResize)
  rfb.on('frame', onFrame)
  hub.unsubscribeDisplay = () => {
    rfb.off('update', onUpdate)
    rfb.off('resize', onResize)
    rfb.off('frame', onFrame)
  }
  // The framebuffer was not kept current while nobody watched: ask for all of it.
  rfb.requestUpdate(false)
}

/** Note regions a watcher has not been sent. Past the most worth keeping apart,
 *  they become one region (their bounding box) at once, so a watcher that falls
 *  far behind costs a few numbers, not a list that grows while it is gone. */
function addPending(v: Viewer, rects: readonly Rect[]): void {
  if (v.needsFull) return
  v.pending.push(...rects)
  if (v.pending.length > MAX_PENDING_RECTS) v.pending = [boundingBox(v.pending)]
}

function boundingBox(rects: readonly Rect[]): Rect {
  let x = Infinity
  let y = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    if (r.x < x) x = r.x
    if (r.y < y) y = r.y
    if (r.x + r.w > x2) x2 = r.x + r.w
    if (r.y + r.h > y2) y2 = r.y + r.h
  }
  return { x, y, w: x2 - x, h: y2 - y }
}

function scheduleUpdate(hub: Hub): void {
  if (hub.updateTimer || !hub.display || hub.viewers.size === 0) return
  hub.updateTimer = setTimeout(() => {
    hub.updateTimer = null
    if (hub.display && hub.viewers.size > 0) hub.display.rfb.requestUpdate(true)
  }, UPDATE_INTERVAL_MS)
  hub.updateTimer.unref()
}

function startBrowserPolling(hub: Hub): void {
  if (hub.browserTimer) return
  const tick = async () => {
    if (hub.browserBusy || hub.display || hub.viewers.size === 0) return
    hub.browserBusy = true
    try {
      const frame = await captureBrowser(hub.agentId).catch(() => null)
      if (hub.display || hub.viewers.size === 0) return
      if (!frame) {
        if (hub.browserState !== 'none') {
          hub.browserState = 'none'
          hub.lastFrameHash = null
          for (const v of hub.viewers) v.sink.send('idle', { reason: 'no-browser' })
        }
        return
      }
      const hash = createHash('sha1').update(frame.data).digest('hex')
      if (hash === hub.lastFrameHash) return
      hub.lastFrameHash = hash
      hub.browserState = 'showing'
      const payload = { mimeType: frame.mimeType, data: frame.data, ts: Date.now() }
      for (const v of hub.viewers) {
        // A backed-up watcher misses this picture and gets the next one.
        if (!v.waitingDrain) sendOrWait(hub, v, 'image', payload)
      }
    } finally {
      hub.browserBusy = false
    }
  }
  hub.browserTimer = setInterval(() => void tick(), BROWSER_FRAME_INTERVAL_MS)
  hub.browserTimer.unref()
  void tick()
}

function stopBrowserPolling(hub: Hub): void {
  if (hub.browserTimer) clearInterval(hub.browserTimer)
  hub.browserTimer = null
  hub.lastFrameHash = null
  hub.browserState = 'unknown'
}

function sendOrWait(hub: Hub, v: Viewer, event: string, data: unknown): void {
  if (v.closed) return
  const ok = v.sink.send(event, data)
  v.lastSentAt = Date.now()
  if (!ok) {
    v.waitingDrain = true
    v.sink.onDrain(() => {
      v.waitingDrain = false
      if (hub.browserTimer) hub.lastFrameHash = null // send the current picture again
      pump(hub, v)
    })
  }
}

/** The regions to send now, merged when there are many or they are large. */
function regionsToSend(v: Viewer, width: number, height: number): Rect[] {
  if (v.needsFull) return [{ x: 0, y: 0, w: width, h: height }]
  const clipped: Rect[] = []
  for (const r of v.pending) {
    const x = Math.max(0, r.x)
    const y = Math.max(0, r.y)
    const w = Math.min(width, r.x + r.w) - x
    const h = Math.min(height, r.y + r.h) - y
    if (w > 0 && h > 0) clipped.push({ x, y, w, h })
  }
  if (clipped.length === 0) return []
  const area = clipped.reduce((n, r) => n + r.w * r.h, 0)
  if (clipped.length > MAX_PENDING_RECTS || area > FULL_SCREEN_SHARE * width * height) {
    return [boundingBox(clipped)]
  }
  return clipped
}

/** Send a watcher what it has not seen of the display, when it can take it. */
function pump(hub: Hub, v: Viewer): void {
  if (v.closed || v.waitingDrain || v.timer || v.encoding) return
  const display = hub.display
  if (!display) return
  const wait = v.lastSentAt + MIN_SEND_INTERVAL_MS - Date.now()
  if (wait > 0) {
    v.timer = setTimeout(() => {
      v.timer = null
      pump(hub, v)
    }, wait)
    v.timer.unref()
    return
  }
  const { fb, width, height } = display.rfb
  if (fb.length !== width * height * 4 || width === 0) return
  const rects = regionsToSend(v, width, height)
  v.pending = []
  v.needsFull = false
  if (rects.length === 0) return
  // Each region is copied out of the framebuffer here, then compressed off the
  // server's thread; what changes meanwhile goes in the next round.
  v.encoding = true
  const jobs = rects.map((r) =>
    encodeRegionPngAsync(fb, width, r.x, r.y, r.w, r.h).then((png) => ({
      ...r,
      png: png.toString('base64'),
    })),
  )
  void Promise.all(jobs)
    .then((out) => {
      v.encoding = false
      if (v.closed) return
      sendOrWait(hub, v, 'rects', { width, height, rects: out })
      if (v.pending.length > 0 || v.needsFull) pump(hub, v)
    })
    .catch((err: unknown) => {
      v.encoding = false
      // Those regions were never sent: the next round, a second from now, sends
      // the whole screen, even if nothing on it changes meanwhile.
      v.needsFull = true
      if (!v.closed && !v.timer) {
        v.timer = setTimeout(() => {
          v.timer = null
          pump(hub, v)
        }, 1_000)
        v.timer.unref()
      }
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'could not encode a picture',
      )
    })
}

function closeViewer(v: Viewer): void {
  if (v.closed) return
  v.closed = true
  if (v.timer) clearTimeout(v.timer)
  v.timer = null
  const hub = hubs.get(v.agentId)
  if (!hub || !hub.viewers.delete(v)) return
  totalViewers -= 1
  viewerDetached(v.agentId, v.id)
  if (hub.viewers.size === 0) {
    stopBrowserPolling(hub)
    hub.unsubscribeDisplay?.()
    hub.unsubscribeDisplay = null
    if (hub.updateTimer) clearTimeout(hub.updateTimer)
    hub.updateTimer = null
    hub.display = null
    hubs.delete(v.agentId)
  }
}

/**
 * Start watching an agent's screen. `resumeViewerId` is the id a watcher had
 * before its connection dropped: given back, it keeps control it held (within
 * the reconnect grace), as long as it comes back the same way it came first.
 * Returns the watcher's id and a function to call when the connection closes.
 */
export function openViewer(
  agentId: string,
  via: ViewerVia,
  sink: ViewerSink,
  resumeViewerId?: string | null,
): { viewerId: string; close: () => void } {
  wire()
  if (resumeViewerId) {
    // The same page coming back while its old stream still looks open (the
    // network changed and the old connection has not timed out yet): the new
    // connection replaces it, rather than counting against the places as a
    // second watcher and finding control held by its own ghost.
    const ghost = [...(hubs.get(agentId)?.viewers ?? [])].find(
      (g) => g.id === resumeViewerId && sameVia(g.via, via),
    )
    if (ghost) {
      ghost.sink.end()
      closeViewer(ghost)
    }
  }
  // After the ghost went: closing it may have closed the hub.
  const hub = hubFor(agentId)
  const full =
    via.kind === 'link'
      ? hub.viewers.size >= MAX_VIEWERS_PER_AGENT - DASHBOARD_PLACES_PER_AGENT ||
        totalViewers >= MAX_VIEWERS - DASHBOARD_PLACES ||
        viewersOfLink(via.linkId) >= MAX_VIEWERS_PER_LINK
      : hub.viewers.size >= MAX_VIEWERS_PER_AGENT || totalViewers >= MAX_VIEWERS
  if (full) {
    if (hub.viewers.size === 0) hubs.delete(agentId)
    throw new LiveViewLimitError()
  }
  let id: string = randomUUID()
  if (resumeViewerId) {
    const c = controllerOf(agentId)
    const sameWay =
      c !== null &&
      c.viewerId === resumeViewerId &&
      (c.via.kind === 'dashboard'
        ? via.kind === 'dashboard'
        : via.kind === 'link' && via.linkId === c.via.linkId)
    if (sameWay && viewerReattached(agentId, resumeViewerId)) id = resumeViewerId
  }
  const v: Viewer = {
    id,
    agentId,
    via,
    sink,
    pending: [],
    needsFull: true,
    waitingDrain: false,
    timer: null,
    lastSentAt: 0,
    encoding: false,
    closed: false,
  }
  const first = hub.viewers.size === 0
  hub.viewers.add(v)
  totalViewers += 1
  sink.send('hello', { viewerId: v.id })
  if (first) {
    hub.display = null
    const display = displayFor(agentId)
    if (display) {
      hub.display = display
      subscribeDisplay(hub, display)
    } else {
      startBrowserPolling(hub)
    }
  } else if (hub.display) {
    pump(hub, v)
  } else {
    // Send the current picture to the newcomer on the next photograph.
    hub.lastFrameHash = null
  }
  sendSource(hub, v)
  if (!hub.display && hub.browserState === 'none') sink.send('idle', { reason: 'no-browser' })
  return { viewerId: v.id, close: () => closeViewer(v) }
}

function viewersOfLink(linkId: string): number {
  let n = 0
  for (const hub of hubs.values()) {
    for (const v of hub.viewers) if (v.via.kind === 'link' && v.via.linkId === linkId) n += 1
  }
  return n
}

function findViewer(agentId: string, viewerId: string): Viewer | null {
  for (const v of hubs.get(agentId)?.viewers ?? []) if (v.id === viewerId) return v
  return null
}

export type ControlResult =
  { ok: true; state: 'you' | 'agent' } | { ok: false; status: number; error: string }

/** Take over the agent's screen for this watcher, or hand it back. */
export function setControl(
  agentId: string,
  viewerId: string,
  via: ViewerVia,
  action: 'take' | 'release',
): ControlResult {
  if (action === 'release') {
    // Handing back works after the view closed too (a tab closing sends it
    // after its stream ended), as long as it comes the same way control was
    // taken: the dashboard for the dashboard, the same link for a link.
    const c = controllerOf(agentId)
    const same =
      c !== null &&
      c.viewerId === viewerId &&
      (c.via.kind === 'dashboard'
        ? via.kind === 'dashboard'
        : via.kind === 'link' && via.linkId === c.via.linkId)
    if (same) releaseControl(agentId, viewerId)
    return { ok: true, state: 'agent' }
  }
  const v = findViewer(agentId, viewerId)
  if (!v || !sameVia(v.via, via)) {
    return { ok: false, status: 404, error: 'This live view is not open.' }
  }
  if (!canControl(v)) {
    return { ok: false, status: 403, error: 'This link can watch only; it cannot take over.' }
  }
  if (!hubs.get(agentId)?.display) {
    return {
      ok: false,
      status: 409,
      error:
        'Take over needs the agent to have a display of its own (Linux). Here you can watch its browser.',
    }
  }
  takeControl(agentId, viewerId, via.kind === 'link' ? { kind: 'link', linkId: via.linkId } : via)
  log.info({ agentId, via: via.kind }, 'a person took over an agent screen')
  return { ok: true, state: 'you' }
}

function sameVia(a: ViewerVia, b: ViewerVia): boolean {
  if (a.kind === 'dashboard') return b.kind === 'dashboard'
  return b.kind === 'link' && b.linkId === a.linkId
}

/** One input event from the person in control. */
export type InputEvent =
  { t: 'p'; x: number; y: number; b: number } | { t: 'k'; s: number; d: boolean }

/** Parse a batch of input events, dropping anything malformed. */
export function parseInputEvents(raw: unknown): InputEvent[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_INPUT_EVENTS) return null
  const out: InputEvent[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') return null
    const ev = e as Record<string, unknown>
    if (ev['t'] === 'p') {
      const { x, y, b } = ev
      if (typeof x !== 'number' || typeof y !== 'number' || typeof b !== 'number') return null
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(b) || b < 0 || b > 255) {
        return null
      }
      out.push({ t: 'p', x, y, b })
    } else if (ev['t'] === 'k') {
      const { s, d } = ev
      // An X keysym: Latin-1 and the function keys, or Unicode (0x01000000 + code point).
      if (typeof s !== 'number' || !Number.isInteger(s) || s <= 0 || s > 0x0110ffff) return null
      if (typeof d !== 'boolean') return null
      out.push({ t: 'k', s, d })
    } else {
      return null
    }
  }
  return out
}

/** Send the controller's input to the agent's display. */
export function sendInput(
  agentId: string,
  viewerId: string,
  via: ViewerVia,
  events: readonly InputEvent[],
): ControlResult {
  const v = findViewer(agentId, viewerId)
  if (!v || !sameVia(v.via, via)) {
    return { ok: false, status: 404, error: 'This live view is not open.' }
  }
  if (!holdsControl(agentId, viewerId)) {
    return { ok: false, status: 409, error: 'Take over first: the agent has control.' }
  }
  const display = hubs.get(agentId)?.display
  if (!display) return { ok: false, status: 409, error: 'The display has stopped.' }
  const hub = hubs.get(agentId)!
  for (const e of events) {
    if (e.t === 'p') {
      display.rfb.pointer(e.x, e.y, e.b)
      hub.pointer = { x: e.x, y: e.y, b: e.b }
    } else {
      display.rfb.key(e.s, e.d)
      if (e.d) hub.keysDown.add(e.s)
      else hub.keysDown.delete(e.s)
    }
  }
  return { ok: true, state: 'you' }
}

/** How many people watch this agent now. */
export function viewerCount(agentId: string): number {
  return hubs.get(agentId)?.viewers.size ?? 0
}

/** End every live view of this agent (it was deleted). */
export function closeAllViewers(agentId: string): void {
  for (const v of [...(hubs.get(agentId)?.viewers ?? [])]) {
    v.sink.send('end', { reason: 'This agent is gone.' })
    v.sink.end()
    closeViewer(v)
  }
}

/** Test seam. */
export function resetLiveViewForTests(): void {
  for (const hub of hubs.values()) {
    for (const v of [...hub.viewers]) closeViewer(v)
  }
  hubs.clear()
  totalViewers = 0
  wired = false
}
