// Setup for the jsdom vitest project (component `.test.tsx` tests). It does four
// things: (1) registers @testing-library/jest-dom matchers (`toBeInTheDocument`,
// `toHaveTextContent`, …); (2) registers the jest-axe `toHaveNoViolations` a11y
// matcher; (3) wires the shared msw request-mock server so each test can register
// `/api/*` handlers and an unhandled request fails loudly; and (4) shims jsdom gaps
// (matchMedia, ResizeObserver) the panels touch on render.

import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import { toHaveNoViolations } from 'jest-axe'

import { server } from './mswServer'
import { assertCatalogEmitted } from './catalogFixtures'

assertCatalogEmitted()

expect.extend(toHaveNoViolations)

// onUnhandledRequest:'error' → any /api/* call without a matching handler fails
// the test. That makes "a flag-off panel makes zero fetches" a guarantee the
// component test encodes, not just something asserted in e2e.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// jsdom has no layout, so `Element.scrollIntoView` is undefined — the chat panels'
// auto-scroll (`bottomRef.current?.scrollIntoView()`) throws in a RAF callback,
// which vitest surfaces as an unhandled error. A no-op shim is enough for render.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

// jsdom implements the *Element* measurement APIs but not the *Range* ones —
// `Range.prototype.getClientRects` / `getBoundingClientRect` and
// `document.elementFromPoint` are all undefined in jsdom 25. CodeMirror 6 runs a
// measure pass on every mount and every dispatch, reaching them via
// drawSelection → coordsAtPos → textRange().getClientRects(); without these it
// catches a TypeError and logs a full stack through `logException` on every
// tick, drowning the test output. Zero-size rects are the honest answer in a
// layout-free DOM and are exactly what CodeMirror already treats as
// "unmeasurable".
const zeroRect = (): DOMRect =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this
    },
  }) as DOMRect

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    const list = [zeroRect()] as unknown as DOMRect[] & DOMRectList
    list.item = (i: number) => list[i] ?? null
    return list
  }
}

if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = zeroRect
}

if (typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null
}
