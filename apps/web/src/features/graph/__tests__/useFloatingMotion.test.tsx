// The graph's idle float writes `el.style.transform` from a shared RAF loop, so
// the global `@media (prefers-reduced-motion: reduce)` block in globals.css —
// which only zeroes CSS animation/transition durations — could never reach it.
//
// Real rAF + waitFor rather than fake timers: fake timers do not intercept
// requestAnimationFrame (see the polyfill note in graphPhysics.test.ts).

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useFloatingMotion } from '../useFloatingMotion'

type Handler = (e: { matches: boolean }) => void

const original = window.matchMedia
const listeners = new Set<Handler>()

function stubMatchMedia(matches: boolean) {
  listeners.clear()
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, h: Handler) => listeners.add(h),
    removeEventListener: (_: string, h: Handler) => listeners.delete(h),
  }
  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia
}

/** Poll a real rAF-driven side effect without fake timers. */
async function until(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await act(async () => {
      await new Promise((r) => setTimeout(r, 16))
    })
  }
  return predicate()
}

afterEach(() => {
  // `subscribers` / `rafId` are module singletons — an un-unmounted hook leaks
  // its subscription into the next test in this file.
  cleanup()
  window.matchMedia = original
  listeners.clear()
})

describe('useFloatingMotion', () => {
  it('writes a transform each frame when motion is allowed', async () => {
    stubMatchMedia(false)
    const el = document.createElement('div')
    const { result } = renderHook(() => useFloatingMotion('boo-a1', 'boo'))
    act(() => result.current(el))

    expect(await until(() => el.style.transform !== '')).toBe(true)
    expect(el.style.transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)$/)
  })

  it('never writes a transform when reduced motion is requested', async () => {
    stubMatchMedia(true)
    const el = document.createElement('div')
    const { result } = renderHook(() => useFloatingMotion('boo-a1', 'boo'))
    act(() => result.current(el))

    // Give the loop several frames' worth of wall clock to prove it never runs.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(el.style.transform).toBe('')
  })

  // The loop is a shared singleton, so a one-shot read at mount would keep every
  // node on the canvas bobbing after the user flips the OS setting.
  it('clears the transform when the preference flips mid-session', async () => {
    stubMatchMedia(false)
    const el = document.createElement('div')
    const { result } = renderHook(() => useFloatingMotion('boo-a1', 'boo'))
    act(() => result.current(el))
    expect(await until(() => el.style.transform !== '')).toBe(true)

    act(() => listeners.forEach((h) => h({ matches: true })))

    expect(await until(() => el.style.transform === '')).toBe(true)
  })
})
