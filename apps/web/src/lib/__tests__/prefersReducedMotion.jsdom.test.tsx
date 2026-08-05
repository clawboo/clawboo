// The browser half of the reduced-motion helper. `.tsx` purely to route this
// file into the jsdom vitest project (the node project globs `*.test.ts`) —
// there is no JSX here.
//
// The setup shim installs a stub `window.matchMedia` only when one is ABSENT,
// so assigning our own per test wins.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { onReducedMotionChange, prefersReducedMotion } from '../prefersReducedMotion'

type Handler = (e: { matches: boolean }) => void

const original = window.matchMedia

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Handler>()
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, h: Handler) => listeners.add(h),
    removeEventListener: (_: string, h: Handler) => listeners.delete(h),
  }
  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia
  return { listeners, fire: (next: boolean) => listeners.forEach((h) => h({ matches: next })) }
}

afterEach(() => {
  window.matchMedia = original
})

describe('prefersReducedMotion (browser)', () => {
  it('reflects the media query', () => {
    stubMatchMedia(true)
    expect(prefersReducedMotion()).toBe(true)

    stubMatchMedia(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('degrades to false when matchMedia throws', () => {
    window.matchMedia = (() => {
      throw new Error('unsupported query')
    }) as unknown as typeof window.matchMedia
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('onReducedMotionChange', () => {
  it('forwards preference flips to the listener', () => {
    const { fire } = stubMatchMedia(false)
    const listener = vi.fn()
    onReducedMotionChange(listener)

    fire(true)
    expect(listener).toHaveBeenCalledWith(true)

    fire(false)
    expect(listener).toHaveBeenLastCalledWith(false)
  })

  it('detaches the same handler on unsubscribe', () => {
    const { listeners, fire } = stubMatchMedia(false)
    const listener = vi.fn()
    const unsubscribe = onReducedMotionChange(listener)
    expect(listeners.size).toBe(1)

    unsubscribe()
    expect(listeners.size).toBe(0)
    fire(true)
    expect(listener).not.toHaveBeenCalled()
  })
})
