import { useCallback, useEffect, useRef, useState } from 'react'

import { onReducedMotionChange, prefersReducedMotion } from '@/lib/prefersReducedMotion'

// ─── Types ───────────────────────────────────────────────────────────────────

type FloatingNodeType = 'boo' | 'skill'

interface MotionParams {
  phase: number
  amplitudeX: number
  amplitudeY: number
  speedX: number
  speedY: number
}

// ─── Amplitude ranges by node type ───────────────────────────────────────────

const AMPLITUDE: Record<
  FloatingNodeType,
  { minX: number; maxX: number; minY: number; maxY: number }
> = {
  boo: { minX: 3, maxX: 5, minY: 3, maxY: 5 },
  skill: { minX: 1.5, maxX: 3, minY: 1.5, maxY: 3 },
}

// Speed range (radians per ms) — yields ~2–4 second cycles
const SPEED_MIN = 0.0004
const SPEED_MAX = 0.0008

// ─── FNV-1a hash ─────────────────────────────────────────────────────────────

function fnv1a(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// ─── Derive deterministic motion params from node ID + type ──────────────────

function deriveParams(nodeId: string, type: FloatingNodeType): MotionParams {
  const hash = fnv1a(nodeId)
  const amp = AMPLITUDE[type]

  // Extract 4 normalized values (0–1) from different byte ranges of the hash
  const n0 = ((hash >>> 0) & 0xff) / 255
  const n1 = ((hash >>> 8) & 0xff) / 255
  const n2 = ((hash >>> 16) & 0xff) / 255
  const n3 = ((hash >>> 24) & 0xff) / 255

  return {
    phase: n0 * Math.PI * 2,
    amplitudeX: amp.minX + n1 * (amp.maxX - amp.minX),
    amplitudeY: amp.minY + n2 * (amp.maxY - amp.minY),
    speedX: SPEED_MIN + n3 * (SPEED_MAX - SPEED_MIN),
    speedY: SPEED_MIN + n0 * (SPEED_MAX - SPEED_MIN),
  }
}

// ─── Singleton RAF loop ──────────────────────────────────────────────────────
//
// One global requestAnimationFrame loop shared across all floating nodes.
// Starts when the first subscriber mounts, stops when the last unmounts.
// Frame rate capped at ~60fps to avoid burning CPU on high-refresh displays.

type Subscriber = (time: number) => void

const subscribers = new Set<Subscriber>()
let rafId: number | null = null
let lastFrameTime = 0

function onFrame(now: number): void {
  if (now - lastFrameTime >= 16) {
    lastFrameTime = now
    for (const sub of subscribers) sub(now)
  }
  if (subscribers.size > 0) {
    rafId = requestAnimationFrame(onFrame)
  } else {
    rafId = null
  }
}

function subscribe(sub: Subscriber): () => void {
  subscribers.add(sub)
  if (subscribers.size === 1) {
    rafId = requestAnimationFrame(onFrame)
  }
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0 && rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────
//
// Returns a ref callback to attach to a wrapper <div>. Each frame, the hook
// writes a CSS transform directly to the DOM — zero React re-renders.
//
// When isDragging is true, the transform is cleared so the float doesn't fight
// the user's drag gesture.

export function useFloatingMotion(
  nodeId: string,
  type: FloatingNodeType,
  isDragging?: boolean,
  /**
   * Skip the RAF subscription entirely. Same treatment as reduced motion: the
   * float is decorative, so anything that makes it pointless should also make it
   * free. Used by the LOD path, where the node is a 10px dot and a sub-pixel
   * orbit is invisible but still costs a per-frame style write per tile.
   */
  disabled?: boolean,
): React.RefCallback<HTMLDivElement> {
  const paramsRef = useRef<MotionParams>(deriveParams(nodeId, type))
  const elementRef = useRef<HTMLDivElement | null>(null)
  const isDraggingRef = useRef(isDragging)
  isDraggingRef.current = isDragging

  // Recompute params if nodeId or type changes (rare — usually stable)
  useEffect(() => {
    paramsRef.current = deriveParams(nodeId, type)
  }, [nodeId, type])

  // Reduced motion: the float is a purely decorative idle animation with no
  // information content, so it is the first thing to drop. Tracked as STATE, not
  // a one-shot read, because the RAF loop is a shared singleton — a stale `false`
  // here would keep it spinning for every node on the canvas after the user
  // flips the OS setting, with no reload to correct it.
  const [reduced, setReduced] = useState(() => prefersReducedMotion())
  useEffect(() => {
    // Re-read on mount too: the preference can change between module import and
    // this node mounting.
    setReduced(prefersReducedMotion())
    return onReducedMotionChange(setReduced)
  }, [])

  // Subscribe to the singleton RAF loop
  const off = reduced || disabled === true
  useEffect(() => {
    if (off) {
      // Clear anything written before the preference flipped, so the node lands
      // back on its exact layout position instead of freezing mid-orbit.
      const el = elementRef.current
      if (el) el.style.transform = ''
      return
    }
    return subscribe((time) => {
      const el = elementRef.current
      if (!el) return

      if (isDraggingRef.current) {
        el.style.transform = ''
        return
      }

      const { phase, amplitudeX, amplitudeY, speedX, speedY } = paramsRef.current
      const x = Math.sin(time * speedX + phase) * amplitudeX
      const y = Math.cos(time * speedY + phase * 0.7) * amplitudeY
      el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
    })
  }, [off])

  return useCallback((el: HTMLDivElement | null) => {
    elementRef.current = el
  }, [])
}
