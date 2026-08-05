// ToastContainer — the app's universal notification channel (82 addToast call
// sites, including every error path). It announced NOTHING to a screen reader
// before this: no role, no aria-live, and tone conveyed only by an aria-hidden
// icon's colour.
//
// The load-bearing design choice these tests pin: the live regions are separate,
// always-mounted sr-only nodes fed from the store — NOT the animated toast list.
// A live region only announces mutations to a region already in the AT tree, and
// AnimatePresence keeps exiting nodes mounted, so a container-as-region would
// both miss the first toast and re-announce expiring ones.

import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { TOAST_TTL_MS, useToastStore } from '@/stores/toast'

import { ToastContainer } from '../ToastContainer'

beforeEach(() => useToastStore.setState({ toasts: [], announcement: null }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function addToast(toast: Parameters<ReturnType<typeof useToastStore.getState>['addToast']>[0]) {
  act(() => useToastStore.getState().addToast(toast))
}

describe('ToastContainer', () => {
  it('mounts both live regions before any toast exists', () => {
    render(<ToastContainer />)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toBeEmptyDOMElement()
  })

  it('announces a success toast politely, with its tone in the text', () => {
    render(<ToastContainer />)
    addToast({ type: 'success', message: 'Task created' })

    expect(screen.getByRole('status')).toHaveTextContent('Success: Task created')
    expect(screen.getByRole('alert')).toBeEmptyDOMElement()
  })

  it('announces an error toast assertively', () => {
    render(<ToastContainer />)
    addToast({ type: 'error', message: 'Couldn’t save' })

    expect(screen.getByRole('alert')).toHaveTextContent('Error: Couldn’t save')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('announces an info toast verbatim, with no tone prefix', () => {
    render(<ToastContainer />)
    addToast({ type: 'info', message: 'Copied' })

    expect(screen.getByRole('status')).toHaveTextContent('Copied')
    expect(screen.getByRole('status').textContent).toBe('Copied')
  })

  it('replaces the announcement when a second toast arrives', () => {
    render(<ToastContainer />)
    addToast({ type: 'info', message: 'First' })
    addToast({ type: 'info', message: 'Second' })

    expect(screen.getByRole('status').textContent).toBe('Second')
  })

  it('names the dismiss control by what activating it does', async () => {
    const user = userEvent.setup()
    render(<ToastContainer />)
    addToast({ type: 'success', message: 'Task created' })

    const dismiss = screen.getByRole('button', { name: 'Dismiss notification: Task created' })
    await user.click(dismiss)

    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('clears the announcement when the toast auto-dismisses', () => {
    vi.useFakeTimers()
    render(<ToastContainer />)
    addToast({ type: 'success', message: 'Task created' })
    expect(screen.getByRole('status')).toHaveTextContent('Success: Task created')

    act(() => vi.advanceTimersByTime(TOAST_TTL_MS))

    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('has no level-A/AA a11y violations with a toast on screen', async () => {
    const { container } = render(<ToastContainer />)
    addToast({ type: 'error', message: 'Something broke' })
    expect(await axe(container)).toHaveNoViolations()
  })
})
