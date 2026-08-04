// navPanels — NavPanel, the per-view lazy panel host. The real panels (ELK /
// CodeMirror / recharts, all fetch-heavy) are stubbed at the module level so what
// is under test is the WIRING: the boundary sitting outside Suspense, the label a
// degraded panel shows, and the per-attempt lazy identity that makes retry work.
//
// ORDERING HAZARD, read before adding a test here: PANEL_SOURCES caches its
// React.lazy per (view, attempt) at MODULE scope, and cleanup() does not reset
// it. Once a view's lazy has resolved in one test it stays resolved for the rest
// of the file, so a later test can no longer observe that view's Suspense
// fallback. Each test therefore claims its OWN view — `memory` for the
// loading→loaded transition, `health` for the happy path, `governance` for the
// degrade + retry path — which keeps them order-independent.
//
// See the ErrorBoundary suite header for why every render goes through
// `renderQuiet`.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from '@/__vitest__/axe'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NAV_VIEW_LABELS } from '@/lib/navLabels'

// NavPanel only calls import() for the view actually being rendered, so only the
// three modules mounted below need stubbing — the other eleven never load.
// (Declared before vi.mock and referenced from inside the factory: vitest hoists
// the vi.mock CALL, but the factory BODY runs at import time, by which point this
// binding is initialised.)
const governancePanel = vi.fn<() => ReactElement>()

vi.mock('@/features/health', () => ({
  SystemHealthPanel: () => <div data-testid="stub-health">system health</div>,
}))
vi.mock('@/features/memory/MemoryPanel', () => ({
  MemoryPanel: () => <div data-testid="stub-memory">memory</div>,
}))
vi.mock('@/features/governance/GovernancePanel', () => ({
  GovernancePanel: () => governancePanel(),
}))

import { NavPanel, getNavPanelSource } from '../navPanels'

function renderQuiet(ui: ReactElement) {
  return render(ui, { onCaughtError: () => {}, onRecoverableError: () => {} })
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
  governancePanel.mockReset()
  vi.restoreAllMocks()
})

describe('getNavPanelSource', () => {
  it('caches per (view, attempt) but mints a FRESH lazy when the attempt bumps', () => {
    // Load-bearing: React.lazy caches a rejected loader on its payload forever, so
    // a retry that reused the same lazy would re-throw without re-fetching.
    const board = getNavPanelSource('board')
    const first = board.get(0)
    expect(board.get(0)).toBe(first)
    expect(board.get(1)).not.toBe(first)
    // …and two views never share a component.
    expect(getNavPanelSource('runtimes').get(0)).not.toBe(first)
  })
})

describe('NavPanel', () => {
  it('shows the Suspense spinner first, then the resolved panel', async () => {
    renderQuiet(<NavPanel view="memory" />)
    // A dynamic import cannot settle inside render()'s synchronous act(), so the
    // Suspense fallback is what paints on pass one.
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-memory')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders the panel for a view', async () => {
    renderQuiet(<NavPanel view="health" />)
    expect(await screen.findByTestId('stub-health')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
  })

  it('degrades a throwing panel to a panel-scoped card with that view’s label, then recovers', async () => {
    const user = userEvent.setup()
    // A closure flag rather than a "once" mock: React may render the panel more
    // than once while unwinding, and a "once" stub would be consumed by the first
    // render, letting the second succeed and hide the error entirely.
    let governanceHealthy = false
    governancePanel.mockImplementation(() => {
      if (!governanceHealthy) throw new Error('governance panel exploded')
      return <div data-testid="stub-governance">governance</div>
    })

    renderQuiet(<NavPanel view="governance" />)

    const fallback = await screen.findByTestId('panel-error-boundary')
    // The boundary sits OUTSIDE Suspense, so the card REPLACES the loading
    // surface rather than rendering under a spinner that never resolves.
    expect(screen.queryByRole('status')).toBeNull()
    expect(fallback).toHaveAttribute('role', 'alert')
    expect(fallback).toHaveTextContent(NAV_VIEW_LABELS.governance)
    expect(fallback).toHaveTextContent('governance panel exploded')
    expect(
      consoleError.mock.calls.some(
        (args) => typeof args[0] === 'string' && args[0].startsWith('[clawboo:error-boundary]'),
      ),
    ).toBe(true)

    governanceHealthy = true
    await user.click(screen.getByTestId('error-boundary-retry'))

    // The retry bumped `attempt`, so NavPanel handed Suspense a brand-new lazy.
    expect(await screen.findByTestId('stub-governance')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
  })

  it('has no level-A/AA a11y violations in the degraded state', async () => {
    governancePanel.mockImplementation(() => {
      throw new Error('governance panel exploded')
    })
    const { container } = renderQuiet(<NavPanel view="governance" />)
    await screen.findByTestId('panel-error-boundary')
    expect(await axe(container)).toHaveNoViolations()
  })
})
