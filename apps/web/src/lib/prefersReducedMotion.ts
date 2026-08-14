// Reduced-motion state for NON-React code.
//
// framer-motion's `useReducedMotion` already covers components (5 call sites),
// but the graph's two RAF loops live outside React: `features/graph/graphPhysics`
// is a module singleton with no component to hook into, and
// `features/graph/useFloatingMotion` writes inline transforms from a shared
// frame loop. The CSS `@media (prefers-reduced-motion: reduce)` block in
// globals.css only zeroes animation/transition durations — it cannot reach
// either of those, so the graph kept bobbing and springing regardless.
//
// EVERY read is guarded for a missing `window` / `matchMedia`. `graphPhysics` is
// imported by a NODE-environment vitest project (apps/web/vite.config.ts routes
// `src/**/*.test.ts` to `environment: 'node'`), where neither exists. With no
// matchMedia we report `false` — "motion allowed" — so the existing physics
// suite keeps passing untouched. Follows the guarded-matchMedia shape already
// used by features/theme/ThemeProvider.tsx.

const QUERY = '(prefers-reduced-motion: reduce)'

// Resolved on every call rather than cached at module scope: tests replace
// `window.matchMedia` per-test (src/__vitest__/setup.ts only installs a shim
// when one is ABSENT), and a captured MediaQueryList would go stale.
function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  try {
    return window.matchMedia(QUERY)
  } catch {
    return null // some embedded webviews throw on an unsupported query
  }
}

/** `true` when the OS asks for reduced motion; always `false` without matchMedia. */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false
}

/**
 * Subscribe to preference changes. Returns an unsubscribe fn — a no-op that
 * never calls back when matchMedia is unavailable, so callers need no
 * environment guard of their own.
 */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  const mql = mediaQuery()
  if (!mql) return () => {}
  const handler = (event: MediaQueryListEvent) => listener(event.matches)
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
