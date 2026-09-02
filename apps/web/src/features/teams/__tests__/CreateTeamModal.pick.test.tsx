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

/**
 * The team grid renders from the emitted catalog index, which is fetched, so the
 * cards land one tick after mount rather than synchronously. Every test that
 * reaches for a card waits on this first.
 */
async function waitForTeamCards() {
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Deploy' }).length).toBeGreaterThan(0),
  )
}

function renderPick(onClose = vi.fn()) {
  const utils = render(
    <ThemeProvider>
      <CreateTeamModal isOpen onClose={onClose} onCreated={vi.fn()} />
    </ThemeProvider>,
  )
  return { ...utils, onClose }
}

describe('CreateTeamModal pick step (shared team showcase)', () => {
  it('renders the marketplace team showcase — header, filters, cards, and Start from scratch', async () => {
    renderPick()
    await waitForTeamCards()
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
    await waitFor(() => expect(screen.getByDisplayValue('New Team')).toBeInTheDocument())
    // The pick showcase is gone.
    expect(screen.queryByTestId('team-start-from-scratch')).not.toBeInTheDocument()
  })

  it('picking a template advances to its customize step (prefilled)', async () => {
    const user = userEvent.setup()
    renderPick()
    await waitForTeamCards()
    const firstDeploy = screen.getAllByRole('button', { name: 'Deploy' })[0]
    await user.click(firstDeploy)
    // Advanced to the customize step (its "Customize team" heading), leaving the
    // pick showcase behind.
    await waitFor(() => expect(screen.getByText('Customize team')).toBeInTheDocument())
    expect(screen.queryByTestId('team-start-from-scratch')).not.toBeInTheDocument()
  })
})

// The modal had NO dialog semantics and no Escape handler at all before it
// adopted the shared <Modal>. The nesting cases matter because it renders the
// TeamTemplateDetail sheet on top of itself: with both traps bound to `window`,
// a naive implementation would close both dialogs on one Escape press.
describe('CreateTeamModal dialog semantics', () => {
  it('is a modal dialog whose name tracks the current step', async () => {
    const user = userEvent.setup()
    renderPick()

    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    await waitForTeamCards()
    await user.click(screen.getAllByRole('button', { name: 'Deploy' })[0] as HTMLElement)
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Customize team' })).toBeInTheDocument(),
    )
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const { onClose } = renderPick()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes only the nested detail sheet, then the modal', async () => {
    const user = userEvent.setup()
    const { onClose } = renderPick()

    await waitForTeamCards()
    await user.click(screen.getAllByRole('button', { name: 'Details' })[0] as HTMLElement)
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(2))

    // First press: the detail sheet only — the modal behind it stays open.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
    expect(onClose).not.toHaveBeenCalled()

    // Second press: now the modal.
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
