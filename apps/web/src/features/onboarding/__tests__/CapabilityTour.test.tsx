import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { CapabilityTour } from '../CapabilityTour'
import { CAPABILITY_TOUR_FLAG } from '@/lib/oneTimeFlag'
import { useSettingsModalStore } from '@/stores/settingsModal'

describe('CapabilityTour', () => {
  afterEach(() => {
    localStorage.clear()
    useSettingsModalStore.setState({ open: false, view: 'runtimes' })
  })

  it('does not open while show=false', () => {
    render(<CapabilityTour show={false} />)
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
  })

  it('auto-opens once when show=true + flag unset; Skip marks it; never re-opens', async () => {
    const { unmount } = render(<CapabilityTour show={true} />)
    expect(screen.getByTestId('capability-tour')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('tour-skip'))
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
    expect(localStorage.getItem(CAPABILITY_TOUR_FLAG)).toBe('1')

    // A fresh mount with the flag set must NOT re-open.
    unmount()
    render(<CapabilityTour show={true} />)
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
  })

  it('"Take me there" opens the step target and closes', async () => {
    render(<CapabilityTour show={true} />)
    await userEvent.click(screen.getByRole('button', { name: /take me there/i }))
    // First step targets Runtimes, which now lives in the Settings modal.
    expect(useSettingsModalStore.getState().open).toBe(true)
    expect(useSettingsModalStore.getState().view).toBe('runtimes')
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
    expect(localStorage.getItem(CAPABILITY_TOUR_FLAG)).toBe('1')
  })
})
