// installGlobalErrorHandlers — the last-resort net for the errors React never
// sees (async callbacks, timers, EventSource handlers, rejected promises).
//
// This file is `.test.tsx` despite containing no JSX: only `src/**/*.test.tsx`
// runs in the jsdom vitest project, and a `.test.ts` would land in the node
// project with no `window` to attach listeners to.
//
// Two jsdom/vitest facts drive its shape:
//
//  • jsdom implements neither `PromiseRejectionEvent` nor real
//    'unhandledrejection' delivery, so the event is synthesised as a plain Event
//    carrying `reason` — which is why the handler under test reads `event.reason`
//    duck-typed instead of branching on the constructor. `promise` is a RESOLVED
//    promise on purpose: a genuinely rejected one would surface as a real Node
//    unhandled rejection and fail the run.
//  • vitest's jsdom environment installs its own window 'error' listener that
//    re-emits `process.emit('uncaughtException', e.error)` — but ONLY while zero
//    USER 'error' listeners are registered (it counts them by patching
//    addEventListener). The disposer tests drop our listener back to zero, so the
//    suite parks one no-op listener for its whole lifetime. Without it, the
//    dispatched ErrorEvent would fail the file instead of being observed.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { installGlobalErrorHandlers, resetGlobalErrorHandlersForTest } from '../globalErrorHandlers'

// See header note 2.
const parkedErrorListener = () => {}
beforeAll(() => window.addEventListener('error', parkedErrorListener))
afterAll(() => window.removeEventListener('error', parkedErrorListener))

function spyConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

let consoleError: ReturnType<typeof spyConsoleError>

beforeEach(() => {
  consoleError = spyConsoleError()
})

afterEach(() => {
  // The handlers are module-level and idempotent; a leaked install would poison
  // the next test's call counts.
  resetGlobalErrorHandlersForTest()
  vi.restoreAllMocks()
})

/** The `[clawboo:…]`-prefixed console.error calls, ignoring any other noise. */
function clawbooLogs() {
  return consoleError.mock.calls.filter(
    (args) => typeof args[0] === 'string' && args[0].startsWith('[clawboo:'),
  )
}

function dispatchWindowError(error: Error) {
  window.dispatchEvent(
    new ErrorEvent('error', {
      message: error.message,
      error,
      filename: 'https://localhost/assets/index.js',
      lineno: 1,
      colno: 1,
    }),
  )
}

function dispatchUnhandledRejection(reason: unknown) {
  window.dispatchEvent(
    Object.assign(new Event('unhandledrejection', { cancelable: true }), {
      reason,
      promise: Promise.resolve(),
    }),
  )
}

describe('installGlobalErrorHandlers', () => {
  it('attaches both a window "error" and an "unhandledrejection" listener', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    installGlobalErrorHandlers()

    const registered = addEventListener.mock.calls.map(([type]) => type)
    expect(registered).toContain('error')
    expect(registered).toContain('unhandledrejection')
  })

  it('console.errors an uncaught window error with the clawboo prefix and the Error itself', () => {
    installGlobalErrorHandlers()
    const boom = new Error('window level boom')

    dispatchWindowError(boom)

    const logs = clawbooLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.[0]).toBe('[clawboo:window-error]')
    expect(logs[0]?.[1]).toBe('window level boom')
    expect((logs[0]?.[2] as { error: unknown }).error).toBe(boom)
  })

  it('console.errors an unhandled promise rejection, reading `reason` off the event', () => {
    installGlobalErrorHandlers()
    const reason = new Error('rejected somewhere async')

    dispatchUnhandledRejection(reason)

    const logs = clawbooLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.[0]).toBe('[clawboo:unhandled-rejection]')
    expect((logs[0]?.[2] as { reason: unknown }).reason).toBe(reason)
  })

  it('ignores AbortError rejections — every panel aborts its fetches on unmount', () => {
    installGlobalErrorHandlers()

    const domAbort = new DOMException('The operation was aborted.', 'AbortError')
    const plainAbort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    dispatchUnhandledRejection(domAbort)
    dispatchUnhandledRejection(plainAbort)

    // Logging routine teardown would bury real errors under one line per
    // navigation, which is worse than not logging at all.
    expect(clawbooLogs()).toHaveLength(0)

    dispatchUnhandledRejection(new Error('a real one'))
    expect(clawbooLogs()).toHaveLength(1)
  })

  it('describes a non-Error rejection reason without throwing', () => {
    installGlobalErrorHandlers()
    dispatchUnhandledRejection('just a string')
    dispatchUnhandledRejection({ weird: true })

    const logs = clawbooLogs()
    expect(logs).toHaveLength(2)
    expect(logs[0]?.[1]).toBe('just a string')
    expect(logs[1]?.[1]).toBe('Unknown error')
  })

  it('is idempotent — installing twice returns the same disposer and logs once', () => {
    const first = installGlobalErrorHandlers()
    const second = installGlobalErrorHandlers()
    expect(second).toBe(first)

    dispatchWindowError(new Error('once please'))
    // A second registration would double every production log line.
    expect(clawbooLogs()).toHaveLength(1)
  })

  it('the disposer removes BOTH listeners', () => {
    installGlobalErrorHandlers()()

    dispatchWindowError(new Error('should be ignored'))
    dispatchUnhandledRejection(new Error('also ignored'))

    expect(clawbooLogs()).toHaveLength(0)
  })

  it('can be re-installed after disposal', () => {
    installGlobalErrorHandlers()()
    installGlobalErrorHandlers()

    dispatchWindowError(new Error('back online'))
    expect(clawbooLogs()).toHaveLength(1)
  })
})
