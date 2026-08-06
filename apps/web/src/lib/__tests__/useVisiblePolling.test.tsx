import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRefreshOnVisible, useVisiblePolling } from '../useVisiblePolling'

// jsdom defines `hidden` as a prototype getter that always reports false, so a
// test drives visibility by shadowing it with an own property and firing the
// event the browser would fire. `afterEach` deletes the shadow to restore the
// prototype getter.
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

function focusWindow(): void {
  window.dispatchEvent(new Event('focus'))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(document, 'hidden')
})

describe('useVisiblePolling', () => {
  it('ticks on the interval while visible, and never on mount', () => {
    const tick = vi.fn()
    renderHook(() => useVisiblePolling(tick, 1000))

    // Not on mount: every call site owns its own initial-load effect, so a mount
    // call here would double-fetch on first render.
    expect(tick).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(3000))
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('makes zero calls while the tab is hidden', () => {
    const tick = vi.fn()
    renderHook(() => useVisiblePolling(tick, 1000))

    act(() => vi.advanceTimersByTime(2000))
    expect(tick).toHaveBeenCalledTimes(2)

    act(() => setHidden(true))
    tick.mockClear()
    act(() => vi.advanceTimersByTime(60_000))
    expect(tick).not.toHaveBeenCalled()
  })

  it('catches up exactly once on return to visible, then resumes the cadence', () => {
    const tick = vi.fn()
    renderHook(() => useVisiblePolling(tick, 1000))

    act(() => setHidden(true))
    act(() => vi.advanceTimersByTime(10_000))
    expect(tick).not.toHaveBeenCalled()

    act(() => setHidden(false))
    expect(tick).toHaveBeenCalledTimes(1) // one catch-up, not one per missed tick

    act(() => vi.advanceTimersByTime(2000))
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('restarts the interval even when the catch-up call is coalesced away', () => {
    const tick = vi.fn()
    renderHook(() => useVisiblePolling(tick, 1000, { refreshOnFocus: true }))

    // A tab switch fires focus AND visibilitychange back to back: the refresh
    // coalesces to one, but the timer must still come back.
    act(() => setHidden(true))
    act(() => {
      setHidden(false)
      focusWindow()
    })
    expect(tick).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(2000))
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('is fully inert when disabled', () => {
    const tick = vi.fn()
    renderHook(() => useVisiblePolling(tick, 1000, { enabled: false }))

    act(() => vi.advanceTimersByTime(5000))
    act(() => setHidden(true))
    act(() => setHidden(false))
    focusWindow()

    expect(tick).not.toHaveBeenCalled()
  })

  it('stops everything on unmount', () => {
    const tick = vi.fn()
    const { unmount } = renderHook(() => useVisiblePolling(tick, 1000))

    act(() => vi.advanceTimersByTime(1000))
    expect(tick).toHaveBeenCalledTimes(1)

    unmount()
    act(() => vi.advanceTimersByTime(10_000))
    act(() => setHidden(false))
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('picks up a new callback without restarting the timer', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ fn }) => useVisiblePolling(fn, 1000), {
      initialProps: { fn: first },
    })

    act(() => vi.advanceTimersByTime(900))
    rerender({ fn: second })
    // Completes the FIRST period. A restarted timer would have reset to 0 here
    // and fired nothing — the whole point of the latest-callback ref.
    act(() => vi.advanceTimersByTime(100))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('ignores window focus unless refreshOnFocus is set', () => {
    const tick = vi.fn()
    renderHook(() => useVisiblePolling(tick, 10_000))

    act(() => focusWindow())
    expect(tick).not.toHaveBeenCalled()
  })

  it('refreshes on window focus with no visibility change when refreshOnFocus is set', () => {
    const tick = vi.fn()
    renderHook(() => useVisiblePolling(tick, 10_000, { refreshOnFocus: true }))

    act(() => focusWindow())
    expect(tick).toHaveBeenCalledTimes(1)
  })
})

describe('useRefreshOnVisible', () => {
  it('refreshes on focus and on becoming visible, never while hidden', () => {
    const refresh = vi.fn()
    renderHook(() => useRefreshOnVisible(refresh))

    act(() => focusWindow())
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(1000))
    act(() => setHidden(true))
    expect(refresh).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(1000))
    act(() => setHidden(false))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('coalesces the focus + visibilitychange pair a tab switch fires', () => {
    const refresh = vi.fn()
    renderHook(() => useRefreshOnVisible(refresh))

    act(() => {
      setHidden(false)
      focusWindow()
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('is fully inert when disabled', () => {
    const refresh = vi.fn()
    renderHook(() => useRefreshOnVisible(refresh, { enabled: false }))

    act(() => focusWindow())
    act(() => setHidden(false))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('stops listening on unmount', () => {
    const refresh = vi.fn()
    const { unmount } = renderHook(() => useRefreshOnVisible(refresh))

    unmount()
    act(() => focusWindow())
    act(() => setHidden(false))
    expect(refresh).not.toHaveBeenCalled()
  })
})
