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
