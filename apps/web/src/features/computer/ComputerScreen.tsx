// An agent's screen, live, with Take over and Hand back.
//
// Shown on the agent's Computer tab, in its Browser card, and on a link's page.
// Where the agent has a display of its own (Linux), whoever may control it can
// take over: the agent's browser and desktop tools then wait, and this view
// sends the person's mouse and keys until they hand it back. Where the agent
// has only its browser (a Mac, Windows), it is a view of that browser.

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type WheelEvent,
} from 'react'

import { keysymFor } from './keysyms'
import { useLiveScreen, type LiveScreenTarget } from './useLiveScreen'

/** RFB button bits: left, middle, right; 3 and 4 are one wheel step up and down. */
function buttonsOf(e: MouseEvent): number {
  return (e.buttons & 1) | ((e.buttons & 4) >> 1) | ((e.buttons & 2) << 1)
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function sourceLabel(source: 'display' | 'browser' | null): string {
  if (source === 'display') return 'Own display'
  if (source === 'browser') return 'Browser'
  return 'Connecting'
}

export function ComputerScreen({
  target,
  readOnly = false,
  compact = false,
  idleFallback,
}: {
  target: LiveScreenTarget
  /** Watch only: no Take over here (a view link's page). */
  readOnly?: boolean
  /** No status bar or controls: the bare screen (a small card). */
  compact?: boolean
  /** Shown instead of the screen while the agent has nothing open to show. */
  idleFallback?: ReactNode
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { state, takeControl, releaseControl, sendInput } = useLiveScreen(target, canvasRef)
  const inControl = state.control === 'you'

  const toDisplay = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    return {
      x: ((e.clientX - r.left) * canvas.width) / r.width,
      y: ((e.clientY - r.top) * canvas.height) / r.height,
    }
  }, [])

  // What is held down on the agent's display, so it can all be let go. Keys are
  // kept by the physical key (`code`), and released with the keysym they were
  // pressed with: Shift+A then Shift up then A up would otherwise press "A" and
  // release "a", and the display keeps "A" down.
  const keysDown = useRef(new Map<string, number>())
  const pointer = useRef({ x: 0, y: 0, b: 0 })

  const releaseAll = useCallback(() => {
    for (const s of keysDown.current.values()) sendInput({ t: 'k', s, d: false })
    keysDown.current.clear()
    if (pointer.current.b !== 0) {
      pointer.current.b = 0
      sendInput({ t: 'p', x: pointer.current.x, y: pointer.current.y, b: 0 })
    }
  }, [sendInput])

  // Focus moving elsewhere (another app, another tab) takes its key-ups and
  // mouse-ups with it: let go of everything rather than leave a key or a button
  // held on the agent's display.
  useEffect(() => {
    if (!inControl) {
      keysDown.current.clear()
      pointer.current.b = 0
      return
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') releaseAll()
    }
    const onUp = () => {
      if (pointer.current.b !== 0) releaseAll()
    }
    window.addEventListener('blur', releaseAll)
    window.addEventListener('mouseup', onUp)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('blur', releaseAll)
      window.removeEventListener('mouseup', onUp)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [inControl, releaseAll])

  const onPointer = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!inControl) return
    const p = toDisplay(e)
    if (!p) return
    if (e.type === 'mousedown') e.currentTarget.focus()
    const b = buttonsOf(e)
    pointer.current = { x: p.x, y: p.y, b }
    sendInput({ t: 'p', x: p.x, y: p.y, b })
  }

  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    if (!inControl) return
    const p = toDisplay(e)
    if (!p) return
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY)
    const delta = sideways ? e.deltaX : e.deltaY
    if (delta === 0) return
    // X's wheel buttons: 4 up, 5 down, 6 left, 7 right (bits 3 to 6).
    const bit = sideways ? (delta < 0 ? 32 : 64) : delta < 0 ? 8 : 16
    const steps = Math.min(5, Math.max(1, Math.round(Math.abs(delta) / 60)))
    const held = pointer.current.b
    for (let i = 0; i < steps; i++) {
      sendInput({ t: 'p', x: p.x, y: p.y, b: held | bit })
      sendInput({ t: 'p', x: p.x, y: p.y, b: held })
    }
  }

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!inControl) return
    const code = e.code || e.key
    if (e.type === 'keydown') {
      const s = keysymFor(e)
      if (s === null) return
      // Kept from the page: Tab must reach the agent's form, not move this page's focus.
      e.preventDefault()
      // On a Mac the browser sends no key-up for a key pressed while Command is
      // down, so the key would stay held on the display: press and release it
      // at once instead.
      if (IS_MAC && e.metaKey && e.key !== 'Meta') {
        sendInput({ t: 'k', s, d: true })
        sendInput({ t: 'k', s, d: false })
        return
      }
      keysDown.current.set(code, s)
      sendInput({ t: 'k', s, d: true })
      return
    }
    const s = keysDown.current.get(code) ?? keysymFor(e)
    keysDown.current.delete(code)
    if (s === null) return
    e.preventDefault()
    sendInput({ t: 'k', s, d: false })
  }

  const canTake = !readOnly && state.canControl && state.source === 'display' && !inControl
  // The canvas stays mounted under the fallback: the first picture may arrive
  // while the fallback shows, and a display's later pictures are only what
  // changed, so a canvas mounted late would miss the rest of the screen.
  const showFallback =
    idleFallback !== undefined && state.status === 'idle' && state.lastFrameAt === null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="computer-screen">
      {!compact && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {sourceLabel(state.source)}
          </span>
          <span
            className={[
              'rounded-full border px-2 py-0.5 font-mono text-[11px]',
              state.control === 'agent'
                ? 'border-border text-muted-foreground'
                : 'border-amber/25 bg-amber/10 text-amber',
            ].join(' ')}
            data-testid="computer-control-state"
          >
            {state.control === 'agent'
              ? 'Agent in control'
              : state.control === 'you'
                ? 'You have control'
                : 'A person has control'}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {state.lastFrameAt !== null && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {new Date(state.lastFrameAt).toLocaleTimeString()}
              </span>
            )}
            {canTake && (
              <button
                type="button"
                onClick={() => void takeControl()}
                className="rounded-md border border-border bg-input px-2 py-0.5 text-[12px] text-foreground hover:bg-foreground/[0.06]"
              >
                Take over
              </button>
            )}
            {inControl && (
              <button
                type="button"
                onClick={() => void releaseControl()}
                className="rounded-md border border-amber/40 bg-amber/10 px-2 py-0.5 text-[12px] text-amber hover:bg-amber/20"
              >
                Hand back
              </button>
            )}
          </span>
        </div>
      )}
      {inControl && !compact && (
        // Said where it matters, not only in the docs: the agent's own programs
        // run as the same user and can read what reaches this screen.
        <p className="text-[11px] leading-snug text-amber" data-testid="computer-control-warning">
          The agent’s own programs share this screen and could see what you type here. Type a
          password only for an agent you trust.
        </p>
      )}
      {state.error && !compact && (
        <p role="alert" className="text-[12px] text-destructive">
          {state.error}
        </p>
      )}
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-lg bg-foreground/[0.04]">
        <canvas
          ref={canvasRef}
          tabIndex={inControl ? 0 : -1}
          aria-label={
            inControl
              ? "The agent's screen. You have control: your mouse and keys go to it."
              : "The agent's screen"
          }
          className={[
            'max-h-full max-w-full rounded-md object-contain',
            state.lastFrameAt === null ? 'invisible' : '',
            inControl ? 'cursor-crosshair outline outline-2 outline-amber' : '',
          ].join(' ')}
          onMouseMove={onPointer}
          onMouseDown={onPointer}
          onMouseUp={onPointer}
          onWheel={onWheel}
          onKeyDown={onKey}
          onKeyUp={onKey}
          onBlur={releaseAll}
          onContextMenu={(e) => {
            if (inControl) e.preventDefault()
          }}
        />
        {showFallback && (
          <div className="absolute inset-0 flex min-h-0 flex-col bg-background">{idleFallback}</div>
        )}
        {state.lastFrameAt === null && !showFallback && (
          <p className="absolute max-w-[42ch] px-6 text-center text-[12px] leading-relaxed text-muted-foreground">
            {state.status === 'ended'
              ? state.endedReason
              : state.status === 'idle'
                ? 'This agent has no browser open right now. Its screen shows here once it opens one.'
                : 'Connecting to the agent’s screen…'}
          </p>
        )}
        {(state.status === 'ended' || state.status === 'idle') && state.lastFrameAt !== null && (
          <p className="absolute bottom-2 rounded-md bg-background/90 px-2 py-1 text-[12px] text-muted-foreground">
            {state.status === 'ended'
              ? state.endedReason
              : 'The browser is closed now. This is the last picture of it.'}
          </p>
        )}
      </div>
    </div>
  )
}
