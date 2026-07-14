import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { CapabilityTour } from '../CapabilityTour'
import { CAPABILITY_TOUR_FLAG } from '@/lib/oneTimeFlag'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useViewStore } from '@/stores/view'
import { useTeamStore } from '@/stores/team'
import { useTourStore } from '@/stores/tour'

// In jsdom the dashboard sidebar isn't mounted, so the spotlight anchors resolve
// to nothing and each spot step gracefully renders its coach-mark card centred.
// The step controls + reveal side-effects (navigation, Settings deep-link) still
// fire, which is what these assertions exercise.
describe('CapabilityTour', () => {
  afterEach(() => {
    localStorage.clear()
    useSettingsModalStore.setState({ open: false, view: 'runtimes', runtimeIntent: null })
    useViewStore.setState({ viewMode: { type: 'nav', view: 'graph' } })
    useTeamStore.setState({ selectedTeamId: null, teams: [] })
    useTourStore.setState({ active: false })
  })

  it('does not open while show=false', () => {
    render(<CapabilityTour show={false} />)
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
    expect(useTourStore.getState().active).toBe(false)
  })

  it('auto-opens once + flags liveness; Skip marks it seen; never re-opens', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<CapabilityTour show={true} />)
    expect(screen.getByTestId('capability-tour')).toBeInTheDocument()
    expect(screen.getByText('Welcome to Clawboo')).toBeInTheDocument()
    // While the tour runs it broadcasts liveness so the FirstRunNudge yields.
    expect(useTourStore.getState().active).toBe(true)

    await user.click(screen.getByTestId('tour-skip'))
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
    expect(localStorage.getItem(CAPABILITY_TOUR_FLAG)).toBe('1')
    expect(useTourStore.getState().active).toBe(false)

    // A fresh mount with the flag set must NOT re-open.
    unmount()
    render(<CapabilityTour show={true} />)
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
  })

  it('walks the app: steps reveal surfaces, Runtimes deep-links Settings, finish opens Group Chat', async () => {
    const user = userEvent.setup()
    render(<CapabilityTour show={true} />)

    // Welcome → Start tour → Your team
    await user.click(screen.getByTestId('tour-next'))
    expect(screen.getByText('Meet your Boos')).toBeInTheDocument()

    // → Atlas (reveals the graph behind the spotlight)
    await user.click(screen.getByTestId('tour-next'))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })

    // → Board
    await user.click(screen.getByTestId('tour-next'))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'board' })

    // → Marketplace
    await user.click(screen.getByTestId('tour-next'))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'marketplace' })

    // → Runtimes → Finish (the inline Settings deep-link is checked separately)
    await user.click(screen.getByTestId('tour-next'))
    expect(screen.getByRole('button', { name: /open settings → runtimes/i })).toBeInTheDocument()

    // → Finish → Open Group Chat with the user's team (navigates + closes + marks seen)
    useTeamStore.setState({ selectedTeamId: 't1' })
    await user.click(screen.getByTestId('tour-next'))
    expect(screen.getByText("You're all set")).toBeInTheDocument()
    await user.click(screen.getByTestId('tour-open-chat'))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'groupChat', teamId: 't1' })
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
    expect(localStorage.getItem(CAPABILITY_TOUR_FLAG)).toBe('1')
  })

  it('Runtimes deep-link opens Settings → Runtimes and ends the tour', async () => {
    const user = userEvent.setup()
    render(<CapabilityTour show={true} />)
    // Advance welcome → fleet → atlas → board → marketplace → runtimes.
    for (let i = 0; i < 5; i++) await user.click(screen.getByTestId('tour-next'))
    await user.click(screen.getByRole('button', { name: /open settings → runtimes/i }))
    expect(useSettingsModalStore.getState().open).toBe(true)
    expect(useSettingsModalStore.getState().view).toBe('runtimes')
    // The tour closes so the Settings modal isn't buried under its overlay.
    expect(screen.queryByTestId('capability-tour')).not.toBeInTheDocument()
    expect(localStorage.getItem(CAPABILITY_TOUR_FLAG)).toBe('1')
  })

  it('Back returns to the previous stop', async () => {
    const user = userEvent.setup()
    render(<CapabilityTour show={true} />)
    await user.click(screen.getByTestId('tour-next')) // welcome → Your team
    expect(screen.getByText('Meet your Boos')).toBeInTheDocument()
    await user.click(screen.getByTestId('tour-back')) // Your team → welcome
    expect(screen.getByText('Welcome to Clawboo')).toBeInTheDocument()
  })

  it('exposes the active step to assistive tech (dialog name/description + live region)', async () => {
    const user = userEvent.setup()
    render(<CapabilityTour show={true} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    // The dialog's name + description track the current step's heading/body.
    const titleId = dialog.getAttribute('aria-labelledby')
    const descId = dialog.getAttribute('aria-describedby')
    expect(titleId && document.getElementById(titleId)).toHaveTextContent('Welcome to Clawboo')
    expect(descId && document.getElementById(descId)).toHaveTextContent(/work together as a team/i)

    // A polite live region carries position + content across transitions.
    const status = within(dialog).getByRole('status')
    expect(status).toHaveTextContent('Step 1 of 7')
    expect(status).toHaveTextContent('Welcome to Clawboo')

    await user.click(screen.getByTestId('tour-next'))
    expect(status).toHaveTextContent('Step 2 of 7')
    expect(status).toHaveTextContent('Meet your Boos')
  })

  it('moves focus into the dialog when it opens', async () => {
    render(<CapabilityTour show={true} />)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })
})
