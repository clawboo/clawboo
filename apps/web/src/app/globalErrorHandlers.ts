// Global (non-React) error capture.
//
// React error boundaries only catch throws during RENDER, in lifecycle methods,
// and in descendant constructors. They do NOT catch:
//   • throws inside event handlers, setTimeout / requestAnimationFrame callbacks
//   • EventSource / WebSocket / fetch handlers — which is most of this app's data
//     layer (zustand + raw fetch/EventSource, not react-query)
//   • rejected promises nobody awaited
//
// Those surface as window 'error' / 'unhandledrejection' events. Clawboo is
// local-first with no error reporting, so routing them through one prefixed
// channel is what makes a user-pasted console dump legible.
//
// Logging ONLY — deliberately no preventDefault(), so the browser's own default
// reporting (and DevTools "pause on exceptions") still fires.

const ERROR_PREFIX = '[clawboo:window-error]'
const REJECTION_PREFIX = '[clawboo:unhandled-rejection]'

let dispose: (() => void) | null = null

/**
 * Aborts are normal teardown here, not failures — every panel that fetches on
 * mount cancels in its effect cleanup (GatewayBootstrap, WelcomeState,
 * useObsStream, the runtime cards…). Logging them would bury real errors in
 * noise on every navigation. Mirrors the existing check in useObsStream.
 */
function isAbort(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && 'name' in reason
    ? (reason as { name?: unknown }).name === 'AbortError'
    : false
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name
  if (typeof reason === 'string') return reason
  return 'Unknown error'
}

/**
 * Install the window-level error + unhandledrejection listeners.
 *
 * Idempotent: repeated calls (a Vite HMR re-eval of the entry, StrictMode
 * double-effects) return the SAME disposer rather than double-registering, which
 * would double every log line.
 *
 * @returns a disposer that removes both listeners and re-arms installation.
 */
export function installGlobalErrorHandlers(): () => void {
  if (dispose) return dispose
  if (typeof window === 'undefined') return () => {}

  const onError = (event: Event): void => {
    const e = event as ErrorEvent
    console.error(ERROR_PREFIX, e.message || describe(e.error), {
      error: e.error,
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null,
    })
  }

  // `reason` is read duck-typed rather than via `instanceof
  // PromiseRejectionEvent` — jsdom does not implement that constructor, and the
  // property is what both real browsers and the test harness carry.
  const onRejection = (event: Event): void => {
    const { reason } = event as PromiseRejectionEvent
    if (isAbort(reason)) return
    console.error(REJECTION_PREFIX, describe(reason), { reason })
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)

  dispose = () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    dispose = null
  }
  return dispose
}

/** Test-only reset, so a suite can install → dispose → install again cleanly. */
export function resetGlobalErrorHandlersForTest(): void {
  dispose?.()
}
