// CreateTeamModal pick step — the first-run "create a team" flow now renders the
// SHARED Marketplace team showcase (TeamShowcaseGrid + the collapsible category
// filter + "Start from scratch"), so it stays consistent with the marketplace.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'

vi.mock('@/lib/hydrateTeams', () => ({ hydrateTeams: vi.fn(async () => {}) }))

const { CreateTeamModal } = await import('../CreateTeamModal')

beforeEach(() => {
  useConnectionStore.setState({ status: 'disconnected', client: null })
  useTeamStore.setState({ teams: [] })
  // The modal fetches runtime statuses on open (for the customize step).
  server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [] })))
})
afterEach(() => cleanup())

function renderPick() {
  return render(
    <ThemeProvider>
      <CreateTeamModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />
    </ThemeProvider>,
  )
}

describe('CreateTeamModal pick step (shared team showcase)', () => {
  it('renders the marketplace team showcase — header, filters, cards, and Start from scratch', () => {
    renderPick()
    expect(screen.getByText('Create a team')).toBeInTheDocument()
    // The shared collapsible category filter row.
    expect(screen.getByRole('group', { name: 'Filter teams by category' })).toBeInTheDocument()
    // The shared "Start from scratch" card (the blank-team path).
    expect(screen.getByTestId('team-start-from-scratch')).toBeInTheDocument()
    // The team cards render (each carries a Deploy button).
    expect(screen.getAllByRole('button', { name: 'Deploy' }).length).toBeGreaterThan(0)
  })

  it('"Start from scratch" jumps to the blank customize step', async () => {
    const user = userEvent.setup()
    renderPick()
    await user.click(screen.getByTestId('team-start-from-scratch'))
    // Customize step for a blank team — the name field defaults to "New Team".
    await waitFor(() =>
      expect(screen.getByDisplayValue('New Team')).toBeInTheDocument(),
    )
    // The pick showcase is gone.
    expect(screen.queryByTestId('team-start-from-scratch')).not.toBeInTheDocument()
  })

  it('picking a template advances to its customize step (prefilled)', async () => {
    const user = userEvent.setup()
    renderPick()
    const firstDeploy = screen.getAllByRole('button', { name: 'Deploy' })[0]
    await user.click(firstDeploy)
    // Advanced to the customize step (its "Customize team" heading), leaving the
    // pick showcase behind.
    await waitFor(() => expect(screen.getByText('Customize team')).toBeInTheDocument())
    expect(screen.queryByTestId('team-start-from-scratch')).not.toBeInTheDocument()
  })
})
