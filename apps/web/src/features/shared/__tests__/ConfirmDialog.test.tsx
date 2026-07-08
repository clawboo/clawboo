// ConfirmDialog — the design-system replacement for native window.confirm.
// Driven imperatively via the confirm() store; resolves true/false on OK / Cancel
// / Escape. RTL + jest-dom.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { confirm, useConfirmStore } from '@/stores/confirm'
import { ConfirmDialog } from '../ConfirmDialog'

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
