// ConfirmDialog — the design-system replacement for native window.confirm.
// Driven imperatively via the confirm() store; resolves true/false on OK / Cancel
// / Escape. RTL + jest-dom.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { confirm, useConfirmStore } from '@/stores/confirm'
import { ConfirmDialog } from '../ConfirmDialog'
import { Modal } from '../Modal'

afterEach(() => {
  // Settle any dangling dialog so a leaked promise can't bleed into the next test.
  if (useConfirmStore.getState().open) act(() => useConfirmStore.getState().settle(false))
  cleanup()
})

describe('ConfirmDialog', () => {
  it('renders nothing until confirm() is called', () => {
    const { container } = render(<ConfirmDialog />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })

  it('resolves true when the primary button is clicked', async () => {
    render(<ConfirmDialog />)
    let result: boolean | undefined
    act(() => {
      void confirm({ title: 'Delete team?', message: 'Cannot be undone.', tone: 'danger' }).then(
        (v) => (result = v),
      )
    })
    expect(await screen.findByTestId('confirm-dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete team?')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('confirm-ok'))
    await waitFor(() => expect(result).toBe(true))
    // The dialog closes after settling.
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument())
  })

  it('resolves false when the cancel button is clicked', async () => {
    render(<ConfirmDialog />)
    let result: boolean | undefined
    act(() => {
      void confirm({ message: 'Discard changes?' }).then((v) => (result = v))
    })
    await screen.findByTestId('confirm-dialog')
    await userEvent.click(screen.getByTestId('confirm-cancel'))
    await waitFor(() => expect(result).toBe(false))
  })

  it('resolves false on Escape', async () => {
    render(<ConfirmDialog />)
    let result: boolean | undefined
    act(() => {
      void confirm({ message: 'Discard changes?' }).then((v) => (result = v))
    })
    await screen.findByTestId('confirm-dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(result).toBe(false))
  })

  it('a press on it never reaches the dialog that asked for it', async () => {
    const onClose = vi.fn()
    render(
      <>
        <Modal open label="Routine" onClose={onClose} data-testid="asking-dialog">
          <p>Asking</p>
        </Modal>
        <ConfirmDialog />
      </>,
    )
    const user = userEvent.setup()
    let result: boolean | undefined
    act(() => {
      void confirm({ message: 'Delete it?' }).then((v) => (result = v))
    })
    await screen.findByTestId('confirm-dialog')
    await user.click(screen.getByTestId('confirm-cancel'))
    await waitFor(() => expect(result).toBe(false))
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      void confirm({ message: 'Delete it?' }).then((v) => (result = v))
    })
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeInTheDocument())
    await user.click(screen.getByTestId('confirm-ok'))
    await waitFor(() => expect(result).toBe(true))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('asking-dialog')).toBeInTheDocument()
  })

  it('uses custom button labels', async () => {
    render(<ConfirmDialog />)
    act(() => {
      void confirm({ message: 'Go ahead?', confirmLabel: 'Disconnect', cancelLabel: 'Keep' })
    })
    await screen.findByTestId('confirm-dialog')
    expect(screen.getByTestId('confirm-ok')).toHaveTextContent('Disconnect')
    expect(screen.getByTestId('confirm-cancel')).toHaveTextContent('Keep')
  })
})

/** A button that asks for a confirmation, as the app's call sites do. */
function Asker({ restoreId }: { restoreId?: string }) {
  return (
    <button
      type="button"
      data-focus-restore-id={restoreId}
      onClick={() => void confirm({ message: 'Delete it?', tone: 'danger' })}
    >
      Delete
    </button>
  )
}

describe('ConfirmDialog focus', () => {
  it('moves focus to the primary button when it opens', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Asker />
        <ConfirmDialog />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toHaveFocus())
  })

  it.each([
    [
      'the primary button',
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByTestId('confirm-ok')),
    ],
    [
      'Cancel',
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.click(screen.getByTestId('confirm-cancel')),
    ],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    ['Enter', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Enter}')],
    [
      'a press on the scrim',
      async () => {
        const scrim = screen.getByTestId('confirm-dialog').parentElement as HTMLElement
        fireEvent.mouseDown(scrim)
      },
    ],
  ])('hands focus back to what opened it after %s', async (_way, close) => {
    const user = userEvent.setup()
    render(
      <>
        <Asker />
        <ConfirmDialog />
      </>,
    )
    const opener = screen.getByRole('button', { name: 'Delete' })
    await user.click(opener)
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toHaveFocus())
    await close(user)
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('hands focus back the moment it closes, not after its exit animation', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Asker />
        <ConfirmDialog />
      </>,
    )
    const opener = screen.getByRole('button', { name: 'Delete' })
    await user.click(opener)
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toHaveFocus())
    act(() => useConfirmStore.getState().settle(false))
    expect(opener).toHaveFocus()
  })

  it('keeps Tab inside while it is open', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Asker />
        <button type="button">Elsewhere</button>
        <ConfirmDialog />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const ok = screen.getByTestId('confirm-ok')
    const cancel = screen.getByTestId('confirm-cancel')
    await waitFor(() => expect(ok).toHaveFocus())
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab({ shift: true })
    expect(ok).toHaveFocus()
    await user.tab()
    await user.tab()
    expect(ok).toHaveFocus()
  })

  it('finds its opener again when the opener was rebuilt while it was open', async () => {
    const user = userEvent.setup()
    // A board card is re-created when its task changes column; the new node
    // carries the same data-focus-restore-id.
    function Rebuilt() {
      const [n, setN] = useState(0)
      return (
        <>
          <Asker key={n} restoreId="task-1" />
          <button type="button" onClick={() => setN((x) => x + 1)}>
            Rebuild
          </button>
        </>
      )
    }
    render(
      <>
        <Rebuilt />
        <ConfirmDialog />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toHaveFocus())
    // Rebuild behind the dialog without moving focus out of it.
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Rebuild', hidden: true })))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus())
  })

  it('hands focus back into the dialog that asked, which stays open', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <>
        <Modal open label="Routine" onClose={onClose} data-testid="asking-dialog">
          <Asker />
        </Modal>
        <ConfirmDialog />
      </>,
    )
    const opener = await screen.findByRole('button', { name: 'Delete' })
    await user.click(opener)
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(opener).toHaveFocus())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('asking-dialog')).toBeInTheDocument()
  })
})
