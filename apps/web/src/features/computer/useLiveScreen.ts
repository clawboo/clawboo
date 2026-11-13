// One agent's screen, live, drawn onto a canvas.
//
// Reads the server's live view stream (see server/api/computer.ts): pictures of
// what changed on the agent's own display, or photographs of its browser where
// it has no display. Says who is in control, takes over and hands back, and
// sends the controller's mouse and keys in small batches.
//
// Used by the dashboard (signed in as usual) and by a link's page (the link's
// token in a header). Reconnects by itself after a dropped connection, naming
// its previous viewer id so a take over survives a network blip.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { createSseParser } from './sse'

export type LiveScreenTarget =
  { kind: 'dashboard'; agentId: string } | { kind: 'link'; token: string }

export type ControlState = 'agent' | 'you' | 'other'

export interface LiveScreenState {
  status: 'connecting' | 'live' | 'idle' | 'ended'
  /** Its own display, or its browser's pictures. */
  source: 'display' | 'browser' | null
  width: number | null
  height: number | null
  control: ControlState
  canControl: boolean
  /** Why the stream ended for good (a revoked link, a deleted agent). */
  endedReason: string | null
  /** When the last picture arrived. */
  lastFrameAt: number | null
  /** The last take over or input error, in words. */
  error: string | null
}

export type InputEvent =
  { t: 'p'; x: number; y: number; b: number } | { t: 'k'; s: number; d: boolean }

const LINK_HEADER = 'x-clawboo-computer-link'
const VIEWER_HEADER = 'x-clawboo-viewer'
const INPUT_FLUSH_MS = 40
const MAX_EVENTS_PER_POST = 200
const INPUT_TIMEOUT_MS = 10_000
const RECONNECT_STEPS_MS = [1_000, 2_000, 5_000, 10_000]
/** The server writes at least every 15 s; this long with nothing means the
 *  connection died quietly (a laptop slept, the network changed). */
const SILENT_STREAM_MS = 40_000

const INITIAL: LiveScreenState = {
  status: 'connecting',
  source: null,
  width: null,
  height: null,
  control: 'agent',
  canControl: false,
  endedReason: null,
  lastFrameAt: null,
  error: null,
}

function request(
  target: LiveScreenTarget,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (target.kind === 'dashboard') {
    return apiFetch(`/api/agents/${encodeURIComponent(target.agentId)}/computer${path}`, init)
  }
  // A link's page is not signed in, and sends no cookie. It mounts no access
  // lock, so a 401 here shows no sign-in screen.
  return apiFetch(`/api/computer-link${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), [LINK_HEADER]: target.token },
    credentials: 'omit',
  })
}

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

export function useLiveScreen(
  target: LiveScreenTarget | null,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): {
  state: LiveScreenState
  takeControl: () => Promise<void>
  releaseControl: () => Promise<void>
  sendInput: (e: InputEvent) => void
} {
  const [state, setState] = useState<LiveScreenState>(INITIAL)
  const viewerId = useRef<string | null>(null)
  const targetKey = target
    ? target.kind === 'dashboard'
      ? `a:${target.agentId}`
      : `l:${target.token}`
    : null
  const targetRef = useRef(target)
  targetRef.current = target
  const queue = useRef<InputEvent[]>([])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** One batch on the wire at a time, so a release never overtakes its press. */
  const posting = useRef(false)
  /** The buttons of the last pointer event, and whether it changed them. */
  const lastButtons = useRef(0)
  const lastWasPress = useRef(false)

  useEffect(() => {
    const t = targetRef.current
    if (!t) return
    let stopped = false
    let attempt = 0
    /** This connection's viewer id, and whether it holds control. */
    let myViewer: string | null = null
    let iHold = false
    let controller: AbortController | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    // Pictures are decoded asynchronously; drawing them in arrival order keeps a
    // later region from being painted over by an earlier one.
    let drawChain: Promise<void> = Promise.resolve()
    viewerId.current = null
    setState(INITIAL)

    const draw = (
      fn: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => Promise<void>,
    ) => {
      drawChain = drawChain
        .then(async () => {
          const canvas = canvasRef.current
          const ctx = canvas?.getContext('2d')
          if (!canvas || !ctx || stopped) return
          await fn(ctx, canvas)
        })
        .catch(() => {})
    }

    const onEvent = (event: string, raw: string) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }
      switch (event) {
        case 'hello':
          viewerId.current = typeof data['viewerId'] === 'string' ? data['viewerId'] : null
          myViewer = viewerId.current
          attempt = 0
          break
        case 'source': {
          const source = data['source'] === 'display' ? 'display' : 'browser'
          const width = typeof data['width'] === 'number' ? data['width'] : null
          const height = typeof data['height'] === 'number' ? data['height'] : null
          if (source === 'display' && width && height) {
            draw(async (_ctx, canvas) => {
              if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width
                canvas.height = height
              }
            })
          }
          // A display streams at once; a browser is live once its first
          // picture (or the word that none is open) arrives.
          setState((s) => ({
            ...s,
            status: source === 'display' ? 'live' : s.source === source ? s.status : 'connecting',
            source,
            width,
            height,
          }))
          break
        }
        case 'control':
          iHold = data['state'] === 'you'
          setState((s) => ({
            ...s,
            control: data['state'] === 'you' || data['state'] === 'other' ? data['state'] : 'agent',
            canControl: data['canControl'] === true,
          }))
          break
        case 'rects': {
          const rects = Array.isArray(data['rects'])
            ? (data['rects'] as Record<string, unknown>[])
            : []
          draw(async (ctx) => {
            for (const r of rects) {
              if (typeof r['png'] !== 'string') continue
              const bmp = await createImageBitmap(b64ToBlob(r['png'], 'image/png'))
              ctx.drawImage(bmp, Number(r['x']), Number(r['y']))
              bmp.close()
            }
          })
          setState((s) => ({ ...s, status: 'live', lastFrameAt: Date.now() }))
          break
        }
        case 'image': {
          const mime = typeof data['mimeType'] === 'string' ? data['mimeType'] : 'image/png'
          if (typeof data['data'] !== 'string') break
          const b64 = data['data']
          draw(async (ctx, canvas) => {
            const bmp = await createImageBitmap(b64ToBlob(b64, mime))
            if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
              canvas.width = bmp.width
              canvas.height = bmp.height
            }
            ctx.drawImage(bmp, 0, 0)
            bmp.close()
          })
          setState((s) => ({ ...s, status: 'live', lastFrameAt: Date.now() }))
          break
        }
        case 'idle':
          setState((s) => ({ ...s, status: 'idle' }))
          break
        case 'busy':
          // Every place for a watcher is taken for now: the stream ends, and
          // the reconnect below tries again with the usual back-off.
          setState((s) => ({
            ...s,
            error: typeof data['reason'] === 'string' ? data['reason'] : null,
          }))
          break
        case 'end':
          stopped = true
          setState((s) => ({
            ...s,
            status: 'ended',
            endedReason:
              typeof data['reason'] === 'string' ? data['reason'] : 'The live view ended.',
          }))
          break
      }
    }

    const connect = async () => {
      const ac = new AbortController()
      controller = ac
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      if (viewerId.current) headers[VIEWER_HEADER] = viewerId.current
      try {
        const res = await request(t, '/live', { headers, signal: ac.signal })
        if (res.status === 401 || res.status === 404) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          stopped = true
          setState((s) => ({
            ...s,
            status: 'ended',
            endedReason: body?.error ?? 'This live view is not available.',
          }))
          return
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        const parse = createSseParser((e) => onEvent(e.event, e.data))
        let heardAt = Date.now()
        const watchdog = setInterval(() => {
          if (Date.now() - heardAt > SILENT_STREAM_MS) ac.abort()
        }, SILENT_STREAM_MS / 4)
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done || stopped) break
            heardAt = Date.now()
            parse(value)
          }
        } finally {
          clearInterval(watchdog)
        }
      } catch {
        // Dropped or refused: retried below unless stopped.
      }
      if (stopped) return
      setState((s) => (s.status === 'ended' ? s : { ...s, status: 'connecting' }))
      const wait = RECONNECT_STEPS_MS[Math.min(attempt, RECONNECT_STEPS_MS.length - 1)]!
      attempt += 1
      retry = setTimeout(() => void connect(), wait)
    }
    void connect()

    return () => {
      stopped = true
      controller?.abort()
      if (retry) clearTimeout(retry)
      // Leaving while in control (the view closes, or switches to another
      // agent) hands this agent back at once, with the id this connection had:
      // by the time anything else runs, the next target's connection has none.
      if (iHold && myViewer) {
        void request(t, '/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewerId: myViewer, action: 'release' }),
          // Still sent when the tab itself is closing.
          keepalive: true,
        }).catch(() => {})
      }
    }
    // targetKey stands for the target: a new object with the same agent or link
    // must not reconnect.
  }, [targetKey, canvasRef])

  const control = useCallback(async (action: 'take' | 'release') => {
    const t = targetRef.current
    const id = viewerId.current
    if (!t || !id) return
    try {
      const res = await request(t, '/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerId: id, action }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setState((s) => ({ ...s, error: res.ok ? null : (body?.error ?? `HTTP ${res.status}`) }))
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }))
    }
  }, [])

  const flush = useCallback(function flushNow() {
    flushTimer.current = null
    // Waits for the batch on the wire: it is sent when that one is answered.
    if (posting.current) return
    const t = targetRef.current
    const id = viewerId.current
    // At most this many per request (the server takes up to 256 and refuses a
    // larger batch whole); the rest go in the next one.
    const events = queue.current.splice(0, MAX_EVENTS_PER_POST)
    if (!t || !id || events.length === 0) return
    posting.current = true
    void request(t, '/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: id, events }),
      // A request stuck on a dead connection must not hold every later key.
      signal: AbortSignal.timeout(INPUT_TIMEOUT_MS),
    })
      .then(async (res) => {
        if (res.ok) return
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setState((s) => ({ ...s, error: body?.error ?? `HTTP ${res.status}` }))
      })
      .catch(() => {})
      .finally(() => {
        posting.current = false
        if (queue.current.length > 0) flushNow()
      })
  }, [])

  const sendInput = useCallback(
    (e: InputEvent) => {
      const q = queue.current
      if (e.t === 'p') {
        const press = e.b !== lastButtons.current
        const last = q[q.length - 1]
        // A move collapses into the move before it: only where the pointer ends
        // up matters. A press or release never does, and is never replaced, so
        // it lands where it happened.
        if (!press && last?.t === 'p' && !lastWasPress.current) q[q.length - 1] = e
        else q.push(e)
        lastButtons.current = e.b
        lastWasPress.current = press
      } else {
        q.push(e)
      }
      if (q.length >= MAX_EVENTS_PER_POST) flush()
      else if (!flushTimer.current) flushTimer.current = setTimeout(flush, INPUT_FLUSH_MS)
    },
    [flush],
  )

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current)
    },
    [],
  )

  return {
    state,
    takeControl: useCallback(() => control('take'), [control]),
    releaseControl: useCallback(() => control('release'), [control]),
    sendInput,
  }
}
