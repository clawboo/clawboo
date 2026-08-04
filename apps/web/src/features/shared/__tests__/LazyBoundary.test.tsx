// LazyBoundary — the failed-chunk recovery seam, and the one assertion that
// justifies the whole `lazyRetry` indirection: React.lazy caches a REJECTED
// import on its payload forever, so a boundary that merely clears its error state
// re-throws the same rejection. "Try again" must mint a FRESH lazy.
//
// The loader here is a plain vi.fn(), not a real dynamic import, ON PURPOSE.
// vite-node stores a module's promise BEFORE awaiting it, so an `import()` that
// rejects once stays rejected for the rest of the file — there is no second
// attempt to observe in-process. The contract under test is ours anyway (a new
// lazy per attempt ⇒ the loader runs again), and a vi.fn() pins it exactly, with
// zero coupling to the module registry.
//
// See the ErrorBoundary suite header for why every render goes through
// `renderQuiet`.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRetryableLazy } from '@/lib/lazyRetry'
import { LazyBoundary } from '../LazyBoundary'

function renderQuiet(ui: ReactElement) {
  return render(ui, { onCaughtError: () => {}, onRecoverableError: () => {} })
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('LazyBoundary', () => {
  it('shows the suspense fallback while loading, then the panel', async () => {
    const source = createRetryableLazy(async () => ({
      default: () => <div data-testid="panel">panel content</div>,
    }))

    renderQuiet(
      <LazyBoundary
        source={source}
        label="Board"
        suspenseFallback={<div data-testid="spinner" />}
        render={(Panel) => <Panel />}
      />,
    )

    // The loader promise cannot settle inside render()'s synchronous act(), so
    // the Suspense fallback is what paints on pass one.
    expect(screen.getByTestId('spinner')).toBeInTheDocument()
    expect(await screen.findByTestId('panel')).toBeInTheDocument()
    expect(screen.queryByTestId('spinner')).toBeNull()
  })

  it('catches a rejected chunk and RE-IMPORTS on Try again', async () => {
    const user = userEvent.setup()
    let loads = 0
    const source = createRetryableLazy(async () => {
      loads += 1
      if (loads === 1) throw new Error('Failed to fetch dynamically imported module')
      return { default: () => <div data-testid="panel">panel content</div> }
    })

    renderQuiet(
      <LazyBoundary
        source={source}
        label="Board"
        suspenseFallback={<div data-testid="spinner" />}
        render={(Panel) => <Panel />}
      />,
    )

    // The rejection surfaces asynchronously through Suspense. The boundary is
    // OUTSIDE Suspense, so the card REPLACES the spinner rather than leaving a
    // spinner that will never resolve.
    const fallback = await screen.findByTestId('panel-error-boundary')
    expect(fallback).toHaveTextContent(/failed to fetch dynamically imported module/i)
    expect(screen.queryByTestId('spinner')).toBeNull()
    expect(loads).toBe(1)

    await user.click(screen.getByTestId('error-boundary-retry'))

    expect(await screen.findByTestId('panel')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
    // The proof: import() ran a SECOND time. Reusing the lazy would leave this at
    // 1 and re-throw the cached rejection straight back onto the card.
    expect(loads).toBe(2)
  })

  it('starts a fresh mount on the attempt that already succeeded, not on the failed one', async () => {
    const user = userEvent.setup()
    let loads = 0
    const source = createRetryableLazy(async () => {
      loads += 1
      if (loads === 1) throw new Error('chunk gone')
      return { default: () => <div data-testid="panel">panel content</div> }
    })
    const tree = (
      <LazyBoundary
        source={source}
        label="Board"
        suspenseFallback={<div data-testid="spinner" />}
        render={(Panel) => <Panel />}
      />
    )

    const { unmount } = renderQuiet(tree)
    await screen.findByTestId('panel-error-boundary')
    await user.click(screen.getByTestId('error-boundary-retry'))
    await screen.findByTestId('panel')
    unmount()

    // ContentArea remounts the whole view subtree whenever the nav view changes,
    // so a React-state attempt counter would reset to 0 here and drop the user
    // straight back onto the rejected chunk. The counter lives at module scope
    // precisely to prevent that.
    renderQuiet(tree)
    expect(await screen.findByTestId('panel')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
    expect(loads).toBe(2)
  })
})
