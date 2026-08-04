// ErrorBoundary — the app-wide graceful-failure net. Covers what the boundary
// owes its callers: a throwing child degrades to the fallback CARD (not the blank
// tree React gives you by default) WITHOUT taking its siblings down, the error
// plus the React component stack reach console.error, "Try again" and a resetKeys
// change both clear it, the app variant offers a reload, and the card is
// a11y-clean.
//
// Three platform facts keep this suite deterministic:
//
//  1. React 19 splits error reporting. A BOUNDARY-CAUGHT error goes to the root's
//     `onCaughtError` (default: a noisy console.error; nothing is rethrown). An
//     UNCAUGHT one goes to `reportGlobalError` — and jsdom ships no
//     `window.reportError`, so React falls back to dispatching a window 'error'
//     event, which vitest's jsdom env re-emits as an uncaughtException and fails
//     the whole FILE. Nothing here may throw outside a boundary.
//  2. Every render goes through `renderQuiet`, which passes no-op `onCaughtError`
//     + `onRecoverableError` (RTL 16 forwards both to createRoot; it rejects
//     `onUncaughtError` outright). That mutes React's own log so the spy sees only
//     our line, and closes the recoverable-error → reportGlobalError path.
//     `componentDidCatch` runs on a separate path and still fires.
//  3. Assertions scan console.error's recorded calls for our prefix rather than
//     pinning a call count — React may render a throwing subtree more than once
//     while unwinding, and is free to log alongside us.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from '@/__vitest__/axe'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '../ErrorBoundary'

// ─── harness ────────────────────────────────────────────────────────────────

function renderQuiet(ui: ReactElement) {
  return render(ui, { onCaughtError: () => {}, onRecoverableError: () => {} })
}

function Boom({ message = 'kaboom' }: { message?: string }): never {
  throw new Error(message)
}

/** Throws while `isFailing()` is true — lets a test flip a child healthy.
 *  A closure flag rather than a "once" mock, so it stays correct even when React
 *  renders the child more than once while unwinding to the boundary. */
function Flaky({ isFailing }: { isFailing: () => boolean }) {
  if (isFailing()) throw new Error('flaky child')
  return <div data-testid="flaky-ok">recovered</div>
}

function spyConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

let consoleError: ReturnType<typeof spyConsoleError>

beforeEach(() => {
  consoleError = spyConsoleError()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function boundaryLogs() {
  return consoleError.mock.calls.filter(
    (args) => typeof args[0] === 'string' && args[0].startsWith('[clawboo:error-boundary]'),
  )
}

describe('ErrorBoundary', () => {
  it('renders children untouched, and adds no wrapper element, while nothing throws', () => {
    const { container } = renderQuiet(
      <ErrorBoundary label="Fleet">
        <div data-testid="child">healthy</div>
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
    // Load-bearing: every panel root is `h-full`, so an extra wrapper div would
    // become a `flex: 0 1 auto` item and silently collapse the panel to 0px.
    expect(container.firstElementChild).toBe(screen.getByTestId('child'))
  })

  it('degrades a throwing child to the fallback card and leaves the rest of the tree mounted', () => {
    renderQuiet(
      <div>
        <div data-testid="app-shell">shell chrome</div>
        <ErrorBoundary label="Fleet">
          <Boom message="fleet blew up" />
        </ErrorBoundary>
        <div data-testid="sibling">sibling view</div>
      </div>,
    )

    const fallback = screen.getByTestId('panel-error-boundary')
    expect(fallback).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('heading', { name: /couldn.t load Fleet\./i })).toBeInTheDocument()
    expect(screen.getByTestId('error-boundary-message')).toHaveTextContent('fleet blew up')

    // The whole point of the issue: the blast radius is contained. A blank tree
    // is the regression this guards against.
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(screen.getByTestId('sibling')).toBeInTheDocument()
  })

  it('logs the error AND the React component stack, with the caller’s log context', () => {
    renderQuiet(
      <ErrorBoundary label="Board" logContext={{ navView: 'board' }}>
        <Boom message="stack me" />
      </ErrorBoundary>,
    )

    const [call] = boundaryLogs()
    expect(call).toBeDefined()
    expect(call?.[1]).toBe('stack me')
    const payload = call?.[2] as Record<string, unknown>
    expect(payload.error).toBeInstanceOf(Error)
    expect(payload.label).toBe('Board')
    expect(payload.navView).toBe('board')
    // React always hands componentDidCatch a string, so `typeof` proves nothing —
    // what matters is that it NAMES the thrower, which is the entire reason this
    // log is worth shipping (the browser console cannot give you it).
    expect(payload.componentStack).toEqual(expect.stringContaining('Boom'))
  })

  it('falls back to a generic surface name when no label is given', () => {
    renderQuiet(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { name: /couldn.t load this view\./i })).toBeInTheDocument()
  })

  it('normalises a non-Error throw instead of crashing inside the fallback', () => {
    function ThrowString(): never {
      // Models sloppy third-party code that throws a non-Error.
      const thrown: unknown = 'a bare string'
      throw thrown
    }
    renderQuiet(
      <ErrorBoundary label="Fleet">
        <ThrowString />
      </ErrorBoundary>,
    )
    // Rendering a raw thrown object as a React child would throw INSIDE the
    // fallback — which this boundary cannot catch — escalating a contained panel
    // failure into a white screen.
    expect(screen.getByTestId('error-boundary-message')).toHaveTextContent('a bare string')
  })

  it('"Try again" clears the error, calls onRetry, and re-renders a now-healthy child', async () => {
    const user = userEvent.setup()
    let failing = true
    const onRetry = vi.fn(() => {
      failing = false
    })

    renderQuiet(
      <ErrorBoundary label="Fleet" onRetry={onRetry}>
        <Flaky isFailing={() => failing} />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('panel-error-boundary')).toBeInTheDocument()

    await user.click(screen.getByTestId('error-boundary-retry'))

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('flaky-ok')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
  })

  it('a resetKeys change clears the error; an unchanged resetKeys does not', () => {
    let failing = true
    const { rerender } = renderQuiet(
      <ErrorBoundary label="Fleet" resetKeys={['nav-graph']}>
        <Flaky isFailing={() => failing} />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('panel-error-boundary')).toBeInTheDocument()

    // Same key → the card stays, even though the child would now succeed.
    // Without this half, a boundary that reset on EVERY update would still pass —
    // and `resetKeys` is a fresh array literal on every render, so that bug is a
    // one-character mistake away.
    failing = false
    rerender(
      <ErrorBoundary label="Fleet" resetKeys={['nav-graph']}>
        <Flaky isFailing={() => failing} />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('panel-error-boundary')).toBeInTheDocument()

    // Changed key (the user navigated) → the boundary self-heals.
    rerender(
      <ErrorBoundary label="Fleet" resetKeys={['nav-board']}>
        <Flaky isFailing={() => failing} />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('flaky-ok')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
  })

  it('the app variant renders a full-viewport card whose Reload calls location.reload()', async () => {
    const user = userEvent.setup()
    const reload = vi.fn()

    // jsdom's Location.reload is an OWN, non-writable, NON-configurable property,
    // so vi.spyOn(window.location, 'reload') throws "Cannot redefine property";
    // redefining `location` on a raw jsdom window is blocked too. What works:
    // under vitest's jsdom env `window === globalThis`, and populateGlobal
    // republishes `location` on the global as a CONFIGURABLE accessor, so
    // vi.stubGlobal can swap the whole object. The spread keeps href/origin
    // readable (msw resolves relative URLs against location.href), and
    // vi.unstubAllGlobals() in afterEach restores the original descriptor.
    vi.stubGlobal('location', { ...window.location, reload })

    renderQuiet(
      <ErrorBoundary variant="app" label="Clawboo">
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByTestId('app-error-boundary')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /couldn.t load Clawboo\./i })).toBeInTheDocument()
    await user.click(screen.getByTestId('error-boundary-reload'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('the compact variant renders an icon-only reload, for a column too narrow for a card', () => {
    renderQuiet(
      <ErrorBoundary variant="compact" label="the agent sidebar">
        <Boom />
      </ErrorBoundary>,
    )
    const fallback = screen.getByTestId('compact-error-boundary')
    expect(fallback).toHaveAttribute('role', 'alert')
    // Icon-only, so the accessible name has to carry the whole message.
    expect(
      screen.getByRole('button', { name: /reload the page — couldn.t load the agent sidebar\./i }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('error-boundary-retry')).toBeNull()
  })

  it('a custom fallback replaces the card entirely and still gets a working retry', async () => {
    const user = userEvent.setup()
    let failing = true
    const onRetry = vi.fn(() => {
      failing = false
    })

    renderQuiet(
      <ErrorBoundary
        label="the file editor"
        onRetry={onRetry}
        fallback={({ error, retry }) => (
          <button type="button" data-testid="custom-fallback" onClick={retry}>
            {error.message}
          </button>
        )}
      >
        <Flaky isFailing={() => failing} />
      </ErrorBoundary>,
    )

    expect(screen.getByTestId('custom-fallback')).toHaveTextContent('flaky child')
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()

    await user.click(screen.getByTestId('custom-fallback'))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('flaky-ok')).toBeInTheDocument()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container, rerender } = renderQuiet(
      <ErrorBoundary variant="app" label="Clawboo">
        <Boom message="a11y sweep" />
      </ErrorBoundary>,
    )
    expect(await axe(container)).toHaveNoViolations()

    rerender(
      <ErrorBoundary variant="compact" label="the team sidebar">
        <Boom message="a11y sweep" />
      </ErrorBoundary>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
