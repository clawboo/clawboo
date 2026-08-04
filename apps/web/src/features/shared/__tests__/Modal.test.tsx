// Modal — the shared dialog primitive. Asserts the semantics screen readers
// depend on (role + aria-modal + an accessible name), the keyboard contract
// (focus in, Tab trapped, Escape out, focus returned), and the nesting order
// that the focus-trap stack exists to guarantee.

import { useRef, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'

import { Modal } from '../Modal'

afterEach(() => cleanup())

const noop = () => {}

describe('Modal', () => {
  it('renders a labelled, modal dialog', () => {
    render(
      <Modal open label="Settings" onClose={noop}>
        <p>body</p>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('takes its name from labelledBy when given a heading id', () => {
    render(
      <Modal open labelledBy="heading-1" onClose={noop}>
        <h2 id="heading-1">Create a team</h2>
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Create a team' })).toBeInTheDocument()
  })

  it('supports the alertdialog role', () => {
    render(
      <Modal open role="alertdialog" label="Delete team?" onClose={noop}>
        <p>This cannot be undone.</p>
      </Modal>,
    )
    expect(screen.getByRole('alertdialog', { name: 'Delete team?' })).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    render(
      <Modal open={false} label="Settings" onClose={noop}>
        <p>body</p>
      </Modal>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('marks the scrim presentational so it never surfaces as a control', () => {
    render(
      <Modal open label="Settings" onClose={noop} scrimTestId="scrim">
        <p>body</p>
      </Modal>,
    )
    expect(screen.getByTestId('scrim')).toHaveAttribute('role', 'presentation')
  })

  describe('keyboard + focus', () => {
    function TriggerAndModal({ dismissible = true }: { dismissible?: boolean }) {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal
            open={open}
            label="Settings"
            dismissible={dismissible}
            onClose={() => setOpen(false)}
          >
            <button type="button">First</button>
            <button type="button">Last</button>
          </Modal>
        </>
      )
    }

    it('moves focus into the dialog on open and back to the trigger on close', async () => {
      const user = userEvent.setup()
      render(<TriggerAndModal />)
      const trigger = screen.getByRole('button', { name: 'Open' })

      await user.click(trigger)
      await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toHaveFocus())

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // The focus restore lives in a passive-effect cleanup, which React
      // flushes after the dialog's DOM is removed — so restoration lands
      // observably later than the unmount asserted above. Poll for it, or
      // under CI load this reads <body> mid-window and flakes.
      await waitFor(() => expect(trigger).toHaveFocus())
    })

    it('honours initialFocusRef', async () => {
      function WithInitialFocus() {
        const ref = useRef<HTMLButtonElement | null>(null)
        return (
          <Modal open label="Settings" onClose={noop} initialFocusRef={ref}>
            <button type="button">First</button>
            <button type="button" ref={ref}>
              Second
            </button>
          </Modal>
        )
      }
      render(<WithInitialFocus />)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus())
    })

    it('traps Tab within the dialog', async () => {
      const user = userEvent.setup()
      render(<TriggerAndModal />)
      await user.click(screen.getByRole('button', { name: 'Open' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toHaveFocus())

      screen.getByRole('button', { name: 'Last' }).focus()
      await user.tab()
      expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
    })

    it('closes on a scrim mousedown but not on a panel mousedown', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <Modal open label="Settings" onClose={onClose} scrimTestId="scrim">
          <button type="button">Inside</button>
        </Modal>,
      )

      await user.click(screen.getByRole('button', { name: 'Inside' }))
      expect(onClose).not.toHaveBeenCalled()

      await user.click(screen.getByTestId('scrim'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('ignores Escape and scrim dismissal when not dismissible', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(
        <Modal open label="Deploying" dismissible={false} onClose={onClose} scrimTestId="scrim">
          <button type="button">Inside</button>
        </Modal>,
      )

      await user.keyboard('{Escape}')
      await user.click(screen.getByTestId('scrim'))
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  describe('nesting', () => {
    function NestedModals({ onOuterClose }: { onOuterClose: () => void }) {
      const [innerOpen, setInnerOpen] = useState(false)
      return (
        <>
          <Modal open label="Outer" onClose={onOuterClose}>
            <button type="button" onClick={() => setInnerOpen(true)}>
              Open inner
            </button>
          </Modal>
          <Modal open={innerOpen} layer={70} label="Inner" onClose={() => setInnerOpen(false)}>
            <button type="button">Inner control</button>
          </Modal>
        </>
      )
    }

    it('closes the innermost dialog first, then the outer', async () => {
      const user = userEvent.setup()
      const onOuterClose = vi.fn()
      render(<NestedModals onOuterClose={onOuterClose} />)

      await user.click(screen.getByRole('button', { name: 'Open inner' }))
      await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2))

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
      expect(onOuterClose).not.toHaveBeenCalled()

      await user.keyboard('{Escape}')
      expect(onOuterClose).toHaveBeenCalledTimes(1)
    })

    it('keeps Tab inside the inner dialog', async () => {
      const user = userEvent.setup()
      render(<NestedModals onOuterClose={noop} />)

      await user.click(screen.getByRole('button', { name: 'Open inner' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Inner control' })).toHaveFocus(),
      )

      await user.tab()
      expect(screen.getByRole('button', { name: 'Inner control' })).toHaveFocus()
    })
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(
      <Modal open labelledBy="heading-2" onClose={noop}>
        <h2 id="heading-2">Create a team</h2>
        <button type="button">Continue</button>
      </Modal>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
