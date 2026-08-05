// AgentFileEditorOverlay — the editor's failure surface.
//
// The happy path is just a lazy CodeMirror mount and isn't worth a jsdom test.
// What IS worth locking in is the fallback: it dims the whole app, so it owes the
// same keyboard contract as the editor it replaces. A `role="alert"` div (which
// this shipped as first) leaves a keyboard or screen-reader user able to tab
// straight out of a full-screen overlay, with no way back to Try again / Close.
// These assertions are the reason it goes through `Modal`.
//
// The editor module is stubbed with a component that throws, which trips the
// boundary through exactly the same path a rejected chunk import does — without
// depending on vitest's module-registry behaviour for a rejected dynamic import.
//
// `renderQuiet` mutes React's own caught-error logging; see the ErrorBoundary
// suite header for why that matters in jsdom.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from '@/__vitest__/axe'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../AgentFileEditor', () => ({
  AgentFileEditor: () => {
    throw new Error('Failed to fetch dynamically imported module')
  },
}))

import { AgentFileEditorOverlay } from '../AgentFileEditorOverlay'
import { useEditorStore } from '@/stores/editor'

function renderQuiet(ui: ReactElement) {
  return render(ui, { onCaughtError: () => {}, onRecoverableError: () => {} })
}

/** Opens the overlay and waits for the boundary to settle on its fallback. */
async function openFailingEditor() {
  const view = renderQuiet(<AgentFileEditorOverlay />)
  act(() => useEditorStore.getState().openEditor('a1', 'Research Boo'))
  await screen.findByTestId('editor-error-boundary')
  return view
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  act(() => useEditorStore.getState().closeEditor())
  vi.restoreAllMocks()
})

describe('AgentFileEditorOverlay — failure surface', () => {
  it('renders nothing while the editor is closed', () => {
    const { container } = renderQuiet(<AgentFileEditorOverlay />)
    expect(container).toBeEmptyDOMElement()
  })

  it('degrades a failed editor to a NAMED alertdialog, not a bare alert div', async () => {
    await openFailingEditor()

    const dialog = screen.getByRole('alertdialog', { name: /couldn.t load the file editor\./i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveTextContent('Failed to fetch dynamically imported module')
  })

  it('puts initial focus on the recovery action so the keyboard path is reachable', async () => {
    await openFailingEditor()
    // Modal's trap lands on the panel's first focusable; "Try again" is first on
    // purpose — recovery should be under the user's hands, not Close.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus())
  })

  it('Close dismisses the editor, and Escape does too', async () => {
    const user = userEvent.setup()
    await openFailingEditor()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(useEditorStore.getState().isOpen).toBe(false))

    // Escape is Modal's own binding — worth asserting here because the fallback
    // passes `onClose`, and a fallback that swallowed Escape would trap the user
    // in a dead overlay.
    act(() => useEditorStore.getState().openEditor('a1', 'Research Boo'))
    await screen.findByTestId('editor-error-boundary')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(useEditorStore.getState().isOpen).toBe(false))
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = await openFailingEditor()
    expect(await axe(container)).toHaveNoViolations()
  })
})
