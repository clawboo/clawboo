// Home settings show what the server saved as soon as it answers, not when Home's
// next read lands (and still show it if that read fails), and say only what Home
// shows about a lead-written status line.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultHomeSettings } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { useToastStore } from '@/stores/toast'

import { HomeSettingsDialog } from '../HomeSettingsDialog'

const T = { timeout: 4000 }

afterEach(cleanup)

describe('Home settings', () => {
  it('shows the lead-written switch on once the save answers, before Home reads again', async () => {
    server.use(
      http.put('/api/home/teams/:teamId/settings', () =>
        HttpResponse.json({ settings: { ...defaultHomeSettings(), leadWritesStatus: true } }),
      ),
    )
    const onChanged = vi.fn()
    const user = userEvent.setup()
    // The parent's settings never change here: as when Home's refresh fails.
    render(
      <HomeSettingsDialog
        open
        onClose={() => {}}
        teamId="t1"
        teamName="Launch"
        settings={defaultHomeSettings()}
        onChanged={onChanged}
      />,
    )
    const toggle = await screen.findByRole('switch', { name: 'The lead writes the status line' }, T)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'), T)
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ leadWritesStatus: true }))
  })

  it('shows weekly updates on once turned on', async () => {
    server.use(
      http.post('/api/home/teams/:teamId/weekly-updates', () =>
        HttpResponse.json({
          routineId: 'r1',
          created: true,
          settings: { ...defaultHomeSettings(), weeklyUpdatesRoutineId: 'r1' },
        }),
      ),
    )
    const user = userEvent.setup()
    render(
      <HomeSettingsDialog
        open
        onClose={() => {}}
        teamId="t1"
        teamName="Launch"
        settings={defaultHomeSettings()}
        onChanged={() => {}}
      />,
    )
    await user.click(await screen.findByTestId('home-weekly-on', {}, T))
    expect(await screen.findByTestId('home-weekly-manage', {}, T)).toBeInTheDocument()
  })

  it('says why the switch is off for a lead that cannot write the line, and keeps it off', async () => {
    render(
      <HomeSettingsDialog
        open
        onClose={() => {}}
        teamId="t1"
        teamName="Launch"
        settings={{ ...defaultHomeSettings(), leadCanWriteStatus: false }}
        onChanged={() => {}}
      />,
    )
    const toggle = await screen.findByRole('switch', { name: 'The lead writes the status line' }, T)
    expect(toggle).toBeDisabled()
    expect(screen.getByTestId('home-lead-cannot-write')).toHaveTextContent(
      'an OpenClaw lead has no way to',
    )
  })

  it('says so in plain words when the server refuses the lead line', async () => {
    useToastStore.setState({ toasts: [] })
    server.use(
      http.put('/api/home/teams/:teamId/settings', () =>
        HttpResponse.json({ ok: false, error: 'lead_cannot_write' }, { status: 409 }),
      ),
    )
    const user = userEvent.setup()
    render(
      <HomeSettingsDialog
        open
        onClose={() => {}}
        teamId="t1"
        teamName="Launch"
        settings={defaultHomeSettings()}
        onChanged={() => {}}
      />,
    )
    const toggle = await screen.findByRole('switch', { name: 'The lead writes the status line' }, T)
    await user.click(toggle)
    await waitFor(
      () =>
        expect(useToastStore.getState().toasts[0]?.message).toMatch(
          /lead cannot write the status line/,
        ),
      T,
    )
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('does not promise a run link Home does not show', async () => {
    render(
      <HomeSettingsDialog
        open
        onClose={() => {}}
        teamId="t1"
        teamName="Launch"
        settings={defaultHomeSettings()}
        onChanged={() => {}}
      />,
    )
    const dialog = await screen.findByTestId('home-settings', {}, T)
    expect(dialog).toHaveTextContent('Home names the lead and the model under the line.')
    expect(dialog).not.toHaveTextContent(/run behind it/)
  })
})
