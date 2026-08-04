// CreateBooModal — dialog semantics + the keyboard contract it never had.
//
// Two of these guard specific regressions the <Modal> adoption fixed:
//   • Escape used to be an `onKeyDown` on a NON-focusable backdrop div, so it
//     silently did nothing whenever focus sat on <body> (the default, since
//     there was no focus trap to move it in).
//   • The name input was focused by a bare `setTimeout(…, 100)`. That timeout is
//     gone — the focus trap lands on the panel's first focusable, which IS the
//     name input. If someone re-orders the fields, this test fails.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { useConnectionStore } from '@/stores/connection'

import { CreateBooModal } from '../CreateBooModal'

// The create path is stubbed so a test can hold it in flight; the dialog's
// dismissal contract is what's under test, not agent creation.
const { createAgentMock } = vi.hoisted(() => ({ createAgentMock: vi.fn() }))
vi.mock('@/lib/createAgent', () => ({ createAgent: createAgentMock }))

afterEach(() => {
  cleanup()
  createAgentMock.mockReset()
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: '' })
})

const noop = () => {}

describe('CreateBooModal', () => {
  it('is a labelled modal dialog', () => {
    render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    const dialog = screen.getByRole('dialog', { name: 'Create a new Boo' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('renders nothing when closed', () => {
    render(<CreateBooModal isOpen={false} onClose={noop} onCreated={noop} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves focus to the Name field on open', async () => {
    render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus())
  })

  it('associates both field labels with their controls', () => {
    render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    expect(screen.getByLabelText('Name')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Role (optional)').tagName).toBe('TEXTAREA')
  })

  it('closes on Escape even when focus has not been moved by hand', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<CreateBooModal isOpen onClose={onClose} onCreated={noop} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a scrim mousedown but not on a panel mousedown', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(<CreateBooModal isOpen onClose={onClose} onCreated={noop} />)

    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    await user.click(container.querySelector('[role="presentation"]') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Cancel is disabled while the write runs, which states the intent. Escape and
  // the scrim have to honour it too, or the dialog vanishes while createAgent and
  // the follow-up POSTs keep going and the agent appears anyway.
  it('ignores Escape and the scrim while a create is in flight', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    // Never resolves, so `creating` stays true for the duration of the test.
    createAgentMock.mockImplementation(() => new Promise<string>(() => {}))
    useConnectionStore.setState({ status: 'connected', client: {} as never, gatewayUrl: '' })

    const { container } = render(<CreateBooModal isOpen onClose={onClose} onCreated={noop} />)
    await user.type(screen.getByLabelText('Name'), 'Scout')
    await user.click(screen.getByRole('button', { name: 'Create Boo' }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalled())

    await user.keyboard('{Escape}')
    await user.click(container.querySelector('[role="presentation"]') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
