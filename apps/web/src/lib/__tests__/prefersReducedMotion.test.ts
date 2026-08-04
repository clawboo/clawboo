// The invariant that keeps the 18 KB node-env graphPhysics suite green: with no
// `window`/`matchMedia` at all, the helper reports "motion allowed" and the
// subscription is an inert no-op. This file is deliberately `.test.ts`, so it
// runs in the NODE vitest project — the same environment graphPhysics is tested
// in. If it ever runs in jsdom it stops proving anything.

import { describe, expect, it, vi } from 'vitest'

import { onReducedMotionChange, prefersReducedMotion } from '../prefersReducedMotion'

describe('prefersReducedMotion (no window)', () => {
  it('confirms the environment really has no window', () => {
    expect(typeof window).toBe('undefined')
  })

  it('reports false rather than throwing', () => {
    expect(prefersReducedMotion()).toBe(false)
  })

  it('returns a callable unsubscribe that never fires the listener', () => {
    const listener = vi.fn()
    const unsubscribe = onReducedMotionChange(listener)
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })
})
