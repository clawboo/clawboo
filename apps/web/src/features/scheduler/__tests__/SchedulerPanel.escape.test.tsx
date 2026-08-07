// Issue #95, the exact reported repro: in the Scheduler's "New schedule"
// dialog, opening the Agent <Select> and pressing Escape used to close the
// WHOLE dialog and discard the typed label.
//
// Both handlers were `document` + CAPTURE — Select's to dismiss its popover,
// ScheduleDialog's to beat the app-shell Escape — and `stopPropagation()` does
// not suppress a sibling on the same target in the same phase, so both ran. The
// dialog's listener was registered first (on mount), so `onClose()` won.
//
// Now both go through the shared dismissable-layer stack, which hands Escape to
// the topmost layer only, and a popover outranks a dialog.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { SchedulerPanel } from '../SchedulerPanel'

afterEach(() => cleanup())

const AGENTS = {
  defaultId: '',
  mainKey: 'main',
  stale: false,
  agents: [
    { id: 'main', displayName: 'Main', runtime: 'openclaw', teamId: 't1' },
    { id: 'n1', displayName: 'Coder', runtime: 'clawboo-native', teamId: 't1' },
  ],
}

beforeEach(() => {
  server.use(
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules: [],
        sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
      }),
    ),
    http.get('/api/agents', () => HttpResponse.json(AGENTS)),
  )
})

describe('ScheduleDialog — Escape on an open Select (issue #95)', () => {
  it('dismisses only the dropdown, keeping the dialog and the typed label', async () => {
    const user = userEvent.setup()
    render(<SchedulerPanel />)

    await user.click(await screen.findByTestId('schedule-create-open'))
    const dialog = await screen.findByTestId('schedule-dialog')

    await user.type(within(dialog).getByTestId('schedule-label'), 'Nightly sweep')

    // Open the Agent dropdown, then press Escape to dismiss just the dropdown.
    await user.click(within(dialog).getByTestId('schedule-agent'))
    expect(await screen.findByRole('option', { name: /Coder/ })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    // The menu closes. The dialog — and the typed label — survive.
    await waitFor(() => expect(screen.queryByRole('option', { name: /Coder/ })).toBeNull())
    expect(screen.getByTestId('schedule-dialog')).toBeInTheDocument()
    expect(within(dialog).getByTestId('schedule-label')).toHaveValue('Nightly sweep')
  })

  it('closes the dialog on the NEXT Escape, once no dropdown is open', async () => {
    const user = userEvent.setup()
    render(<SchedulerPanel />)

    await user.click(await screen.findByTestId('schedule-create-open'))
    const dialog = await screen.findByTestId('schedule-dialog')
    await user.type(within(dialog).getByTestId('schedule-label'), 'Nightly sweep')

    await user.click(within(dialog).getByTestId('schedule-agent'))
    await screen.findByRole('option', { name: /Coder/ })

    await user.keyboard('{Escape}') // dropdown only
    await waitFor(() => expect(screen.queryByRole('option', { name: /Coder/ })).toBeNull())
    expect(screen.getByTestId('schedule-dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}') // now the dialog
    await waitFor(() => expect(screen.queryByTestId('schedule-dialog')).toBeNull())
  })

  it('closes the dialog on a single Escape when no dropdown is open', async () => {
    const user = userEvent.setup()
    render(<SchedulerPanel />)

    await user.click(await screen.findByTestId('schedule-create-open'))
    await screen.findByTestId('schedule-dialog')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('schedule-dialog')).toBeNull())
  })
})
