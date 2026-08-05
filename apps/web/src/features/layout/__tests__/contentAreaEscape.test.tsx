// The app-shell Escape fallback vs. an open dialog — against the REAL ContentArea.
//
// `ContentArea` registers its Escape handler on DOCUMENT in the BUBBLE phase, and
// `Modal` registers its own on WINDOW in the bubble phase. Document-bubble runs
// FIRST, so the dialog cannot defer to the shell and cannot suppress it with
// `stopPropagation` (they are not the same node). The focus-trap stack is the
// arbitration: if any trap is mounted, the shell stands down.
//
// Without it, Escape inside a dialog opened over an agent / group-chat view also
// deselects the agent and jumps the app to Welcome behind the closing dialog.
//
// The view components are mocked to stubs: this exercises ContentArea's keyboard
// handler, not the panels it renders (which would each need their own /api
// handlers under msw's onUnhandledRequest:'error').

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/agent-detail', () => ({
  AgentDetailView: () => <div data-testid="stub-agent-detail" />,
}))
vi.mock('@/features/group-chat/GroupChatView', () => ({
  GroupChatView: () => <div data-testid="stub-group-chat" />,
}))
vi.mock('@/features/editor/AgentFileEditorOverlay', () => ({
  AgentFileEditorOverlay: () => null,
}))
vi.mock('../WelcomeState', () => ({ WelcomeState: () => <div data-testid="stub-welcome" /> }))
vi.mock('../navPanels', () => ({ NavPanel: () => null }))

const { ContentArea } = await import('../ContentArea')
const { Modal } = await import('@/features/shared/Modal')
const { useViewStore } = await import('@/stores/view')
const { useTeamStore } = await import('@/stores/team')

beforeEach(() => {
  // The team must exist in the store: ContentArea has a guard effect that sends a
  // groupChat view for a deleted team straight back to Welcome, which would
  // otherwise look exactly like the regression under test.
  useTeamStore.setState({
    teams: [{ id: 't1', name: 'Team One' } as never],
    selectedTeamId: 't1',
  })
  useViewStore.getState().setViewMode({ type: 'groupChat', teamId: 't1' })
})

afterEach(() => {
  cleanup()
  useTeamStore.setState({ teams: [], selectedTeamId: null })
})

describe('ContentArea — Escape arbitration', () => {
  it('navigates to Welcome when no dialog is open', async () => {
    const user = userEvent.setup()
    render(<ContentArea />)
    await screen.findByTestId('stub-group-chat')

    await user.keyboard('{Escape}')

    expect(useViewStore.getState().viewMode.type).toBe('welcome')
  })

  it('leaves the view alone while a dialog owns Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <>
        <ContentArea />
        <Modal open onClose={onClose} label="An overlay" data-testid="overlay">
          <button type="button">something</button>
        </Modal>
      </>,
    )
    await screen.findByTestId('overlay')

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
    // The load-bearing half: the app did NOT navigate out from under the dialog.
    expect(useViewStore.getState().viewMode.type).toBe('groupChat')
  })

  it('hands Escape back to the app shell once the dialog closes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <>
        <ContentArea />
        <Modal open onClose={vi.fn()} label="An overlay" data-testid="overlay">
          <button type="button">something</button>
        </Modal>
      </>,
    )
    await screen.findByTestId('overlay')

    rerender(<ContentArea />)
    await waitFor(() => expect(screen.queryByTestId('overlay')).not.toBeInTheDocument())

    await user.keyboard('{Escape}')

    expect(useViewStore.getState().viewMode.type).toBe('welcome')
  })
})
