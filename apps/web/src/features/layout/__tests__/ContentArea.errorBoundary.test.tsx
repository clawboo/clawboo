// ContentArea — one thing under test here: a crashing VIEW degrades to the
// boundary card while the surrounding shell keeps rendering, and navigating away
// heals it. Everything ContentArea composes (the lazy nav panels, the editor
// overlay, agent detail, group chat) is stubbed, so this exercises ContentArea's
// own wiring rather than fourteen feature panels and their fetches — msw runs
// with `onUnhandledRequest: 'error'`, so a real panel would fail the test on its
// first fetch.
//
// See the ErrorBoundary suite header for why every render goes through
// `renderQuiet`.

import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const welcomeState = vi.fn<() => ReactElement>()

vi.mock('../navPanels', () => ({
  NavPanel: ({ view }: { view: string }) => (
    <div data-testid={`stub-nav-panel-${view}`}>panel:{view}</div>
  ),
}))
vi.mock('../WelcomeState', () => ({ WelcomeState: () => welcomeState() }))
vi.mock('@/features/editor/AgentFileEditorOverlay', () => ({
  AgentFileEditorOverlay: () => <div data-testid="stub-editor-overlay" />,
}))
vi.mock('@/features/agent-detail', () => ({
  AgentDetailView: () => <div data-testid="stub-agent-detail" />,
}))
vi.mock('@/features/group-chat/GroupChatView', () => ({
  GroupChatView: () => <div data-testid="stub-group-chat" />,
}))

import { ContentArea } from '../ContentArea'
import { useViewStore } from '@/stores/view'

function renderQuiet(ui: ReactElement) {
  return render(ui, { onCaughtError: () => {}, onRecoverableError: () => {} })
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  welcomeState.mockReset()
  welcomeState.mockImplementation(() => <div data-testid="stub-welcome">welcome</div>)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  act(() => useViewStore.setState({ viewMode: { type: 'nav', view: 'graph' } }))
})

describe('ContentArea error boundary', () => {
  it('renders the view content plus the shell chrome while nothing throws', () => {
    act(() => useViewStore.setState({ viewMode: { type: 'nav', view: 'board' } }))
    renderQuiet(<ContentArea />)

    expect(screen.getByTestId('stub-nav-panel-board')).toBeInTheDocument()
    expect(screen.getByTestId('stub-editor-overlay')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
  })

  it('a view that throws degrades to the boundary card while the shell survives', () => {
    welcomeState.mockImplementation(() => {
      throw new Error('welcome view exploded')
    })
    act(() => useViewStore.setState({ viewMode: { type: 'welcome' } }))

    renderQuiet(<ContentArea />)

    const fallback = screen.getByTestId('panel-error-boundary')
    expect(fallback).toHaveAttribute('role', 'alert')
    expect(fallback).toHaveTextContent('welcome view exploded')
    expect(fallback).toHaveTextContent('the welcome screen')
    // NOT a blank tree: the editor overlay is a sibling outside the boundary and
    // must be completely unaffected by the crash next to it.
    expect(screen.getByTestId('stub-editor-overlay')).toBeInTheDocument()
  })

  it('navigating to another view recovers from a crashed one', async () => {
    welcomeState.mockImplementation(() => {
      throw new Error('welcome view exploded')
    })
    act(() => useViewStore.setState({ viewMode: { type: 'welcome' } }))
    renderQuiet(<ContentArea />)
    expect(screen.getByTestId('panel-error-boundary')).toBeInTheDocument()

    act(() => useViewStore.getState().navigateTo('board'))

    // Two mechanisms produce this and the user-visible outcome is the same either
    // way: AnimatePresence remounts the keyed motion.div (fresh boundary state),
    // and resetKeys={[viewKey]} clears it explicitly. The assertion is on the
    // outcome, not on which one fired. `findBy*` because AnimatePresence
    // mode="wait" plays a 0.15 s exit first.
    expect(await screen.findByTestId('stub-nav-panel-board')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-boundary')).toBeNull()
  })
})
