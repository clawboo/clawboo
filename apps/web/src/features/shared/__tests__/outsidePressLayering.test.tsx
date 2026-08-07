// The outside-press half of issue #95, at the DIALOG boundary.
//
// The Escape half is arbitrated by the layer stack. Press was only half-migrated:
// the popovers joined the press channel, but the dialogs hosting them kept their
// own scrim dismissal as a React `onMouseDown` / `onClick` prop. The stack
// deliberately does NOT stop the press event (a press inside a dialog must still
// activate the button it landed on), so one press on the scrim used to dismiss
// the popover through the stack AND close the dialog through its local handler.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Modal } from '../Modal'
import { Select } from '../Select'

afterEach(() => cleanup())

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
]

function ModalWithSelect({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('a')
  return (
    <Modal open label="Host dialog" onClose={onClose} scrimTestId="host-scrim" data-testid="host">
      <Select aria-label="pick" value={value} onChange={setValue} options={OPTIONS} />
    </Modal>
  )
}

describe('outside-press layering across a dialog boundary', () => {
  it('a press on the scrim with a Select open dismisses only the dropdown', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ModalWithSelect onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'pick' }))
    expect(await screen.findByRole('option', { name: 'Alpha' })).toBeInTheDocument()

    // One press on the scrim, with the dropdown open.
    await user.click(screen.getByTestId('host-scrim'))

    // The dropdown closes...
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Alpha' })).toBeNull())
    // ...and the dialog behind it survives, because the popover owned that press.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a second press on the scrim, with no dropdown open, closes the dialog', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ModalWithSelect onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'pick' }))
    await screen.findByRole('option', { name: 'Alpha' })

    await user.click(screen.getByTestId('host-scrim')) // dropdown only
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Alpha' })).toBeNull())

    await user.click(screen.getByTestId('host-scrim')) // now the dialog
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('a press on the scrim with nothing open closes the dialog immediately', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ModalWithSelect onClose={onClose} />)

    await user.click(screen.getByTestId('host-scrim'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
